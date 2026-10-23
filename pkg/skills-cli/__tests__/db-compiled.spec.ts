import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsCli } from "../build";
import { mergeEnv } from "./module-call";

setDefaultTimeout(60_000);

const root = mkdtempSync(join(tmpdir(), "dg-db-compiled-"));
const cwd = join(root, "external-cwd");
const home = join(root, "home");
const emptyPath = join(root, "empty-bin");
const binary = join(root, "moved-install", "dg-skills");
const entrypoint = join(root, "db-entry.ts");
const dgHome = join(home, ".dg");
const sessionId = "db-compiled-session";
const operations: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(async () => {
	for (const directory of [cwd, home, emptyPath, join(binary, "..")])
		mkdirSync(directory, { recursive: true });
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, instance) {
			const url = new URL(request.url);
			if (url.pathname === "/healthz")
				return Response.json({ instanceId: "db-compiled-daemon" });
			if (
				url.pathname === "/cli" &&
				instance.upgrade(request, { data: undefined })
			)
				return undefined;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			message(socket, raw) {
				const frame = JSON.parse(String(raw)) as {
					requestId: string;
					operation: string;
				};
				operations.push(frame.operation);
				socket.send(
					JSON.stringify({
						type: "cli-credentials-result",
						sessionId,
						requestId: frame.requestId,
						ok: true,
						value: frame.operation === "get" ? null : [],
					}),
				);
			},
		},
	});
	const daemonDir = join(dgHome, "daemon");
	const sessionsDir = join(dgHome, "agents", "sessions");
	mkdirSync(daemonDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(
		join(daemonDir, "daemon.pid"),
		JSON.stringify({
			pid: process.pid,
			port: server.port,
			instanceId: "db-compiled-daemon",
			versions: { package: "1.18.0", protocol: 1 },
		}),
	);
	writeFileSync(
		join(sessionsDir, `${sessionId}.json`),
		JSON.stringify({
			sessionId,
			token: "db-compiled-token",
			cwd: realpathSync(cwd),
			agentIdentity: "db-compiled-test",
		}),
	);
	writeFileSync(
		entrypoint,
		`import { Command } from ${JSON.stringify(Bun.resolveSync("commander", import.meta.dir))};
import { registerDb } from ${JSON.stringify(join(import.meta.dir, "../src/commands/db.ts"))};
const program = new Command().name("dg-skills").enablePositionalOptions();
registerDb(program);
await program.parseAsync(process.argv);
`,
	);
	await buildSkillsCli({ outfile: binary, entrypoint });
}, 240_000);

afterAll(() => {
	server?.stop(true);
	rmSync(root, { recursive: true, force: true });
});

async function run(args: string[]) {
	const proc = Bun.spawn([binary, "db", ...args], {
		cwd,
		env: mergeEnv({ HOME: home, DG_HOME: dgHome, PATH: emptyPath }),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("compiled dg-skills db from an external cwd", () => {
	test("lists an empty fake credential store without legacy scripts or a database", async () => {
		const result = await run(["connections"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toBe("CONNECTIONS: 0\n(none configured)\n");
		expect(result.stderr).toBe("");
		expect(operations).toEqual(["list"]);
	});

	test("help initializes no credential or database connection", async () => {
		operations.length = 0;
		const result = await run(["--help"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("connections");
		expect(result.stderr).toBe("");
		expect(operations).toEqual([]);
	});

	test("a trailing --json on a query reaches argument parsing instead of tripping strict parseArgs", async () => {
		operations.length = 0;
		const result = await run(["query", "nonexistent-conn", "select 1", "--json"]);
		expect(result.stderr).not.toContain("Unknown option");
		expect(result.stderr).toContain('connection "nonexistent-conn" not found');
		expect(operations).toContain("get");
	});

	test("db <subcommand> --help never reaches the subcommand or its credential lookup", async () => {
		operations.length = 0;
		const result = await run(["query", "--help"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("connections");
		expect(result.stderr).toBe("");
		expect(operations).toEqual([]);
	});
});
