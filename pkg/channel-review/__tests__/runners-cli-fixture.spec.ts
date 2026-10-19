import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createRunners, runnerCommand } from "../src/runners";
import {
	createTempHome,
	minimalConfigJson,
	writeConfigFile,
} from "./support/fakes";

let HOME: string;
const URL = "https://github.com/o/r/pull/12";
const FIXTURE = `
import { appendFileSync } from "node:fs";
const keys = [
	"PATH",
	"CLAUDECODE",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"AI_AGENT",
	"XAI_API_KEY",
	"CHANNEL_REVIEW_KEEP",
];
const args = process.argv.slice(2);
const record = process.env.DG_CLI_RECORD;
if (record) {
	appendFileSync(record, JSON.stringify({
		args,
		cwd: process.cwd(),
		env: Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])),
	}) + "\\n");
}
const mode = process.env.DG_CLI_MODE ?? "ok";
if (args[0] === "inspect" && args[1] === "--json") {
	console.log(JSON.stringify({ skills: [{ name: "thrash", userInvocable: true }] }));
	process.exit(0);
}
const probe = (args[0] === "auth" && args[1] === "status") || args[0] === "models";
if (probe) {
	if (mode === "logged-out") {
		console.error("Not logged in");
		process.exit(1);
	}
	if (mode === "unauth-zero") {
		console.log("You are not authenticated.");
		process.exit(0);
	}
	console.log(args[0] === "models" ? "You are using XAI_API_KEY." : "You are logged in");
	process.exit(0);
}
if (mode === "logged-out") {
	console.error("Not logged in");
	process.exit(1);
}
if (mode === "stdout-auth") {
	process.stdout.write('{"type":"error","message":"Not logged in"}\\n');
	process.exit(1);
}
if (mode === "stdout-login") {
	process.stdout.write("Not logged in · Please run /login\\n");
	process.exit(1);
}
if (mode === "exit") process.exit(Number(process.env.DG_CLI_EXIT ?? "3"));
if (mode === "signal") {
	process.kill(process.pid, "SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (mode === "sleep") {
	setInterval(() => {}, 1000);
	await new Promise((resolve) => setTimeout(resolve, 120000));
}
const chunks = [
	'{"type":"text","data":"Hello"}\\n',
	'{"type":"text","data":" review"}\\n',
	'{"type":"end","stopReason":"EndTurn","sessionId":"s1","requestId":"r1"}\\n',
];
for (const chunk of chunks) {
	process.stdout.write(chunk);
	await new Promise((resolve) => setTimeout(resolve, 20));
}
process.stderr.write("stderr-note\\n");
`;

type Invocation = {
	args: string[];
	cwd: string;
	env: Record<string, string | null>;
};

const TOUCHED = [
	"PATH",
	"DG_CLI_MODE",
	"DG_CLI_RECORD",
	"DG_CLI_EXIT",
	"CLAUDECODE",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_PID",
	"CLAUDE_EFFORT",
	"AI_AGENT",
	"XAI_API_KEY",
	"CHANNEL_REVIEW_KEEP",
] as const;

let root: string;
let binDir: string;
let saved: Map<string, string | undefined>;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "cli-fixture-"));
	HOME = root;
	binDir = join(root, "bin");
	mkdirSync(binDir);
	const script = join(root, "cli-fixture.mjs");
	writeFileSync(script, `#!${process.execPath}\n${FIXTURE}`);
	chmodSync(script, 0o755);
	symlinkSync(script, join(binDir, "claude"));
	symlinkSync(script, join(binDir, "grok"));
	saved = new Map(TOUCHED.map((key) => [key, process.env[key]]));
	process.env.PATH = binDir;
	delete process.env.DG_CLI_MODE;
	delete process.env.DG_CLI_EXIT;
	delete process.env.DG_CLI_RECORD;
});

afterEach(() => {
	for (const key of TOUCHED) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function skill(name: "claude" | "grok"): string {
	const dir = name === "grok" ? ".grok/skills" : ".claude/plugins/cache/mkt/dg/1.0.0/plugins/dg/skills";
	return `${HOME}/${dir}/thrash/SKILL.md`;
}

function config(extra: Record<string, unknown> = {}) {
	const home = createTempHome();
	const loaded = loadConfig(
		writeConfigFile(home.dir, minimalConfigJson({ runner: extra })),
	);
	home.cleanup();
	return loaded;
}

function fakeFs(files: string[]) {
	return {
		exists: (path: string) => files.some((file) => file === path || file.startsWith(`${path}/`)),
		readdir: (path: string) => [
			...new Set(
				files
					.filter((file) => file.startsWith(`${path}/`))
					.map((file) => file.slice(path.length + 1).split("/")[0]),
			),
		],
	};
}

function runnersFor(name: "claude" | "grok", runner: Record<string, unknown> = {}) {
	return createRunners(config(runner), {
		homedir: HOME,
		fs: fakeFs([skill(name)]),
	});
}

function runRequest(work: string, logPath: string) {
	return {
		task: "thrash" as const,
		url: URL,
		comment: false,
		cwd: work,
		timeoutMs: 30_000,
		logPath,
		signal: new AbortController().signal,
	};
}

function invocations(record: string): Invocation[] {
	if (!existsSync(record)) return [];
	return readFileSync(record, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Invocation);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
	} catch {
		return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim() !== "";
	}
}

describe("local CLI fixtures", () => {
	test.each(["claude", "grok"] as const)(
		"%s runs from PATH with the runner argv, job cwd, and a filtered env",
		async (name) => {
			process.env.CLAUDECODE = "1";
			process.env.CLAUDE_CODE_ENTRYPOINT = "sdk";
			process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-secret";
			process.env.CLAUDE_PID = "9";
			process.env.CLAUDE_EFFORT = "high";
			process.env.AI_AGENT = "1";
			process.env.XAI_API_KEY = "xai-secret";
			process.env.CHANNEL_REVIEW_KEEP = "yes";
			const record = join(root, "invocations.ndjson");
			const work = join(root, "work");
			const logPath = join(root, "logs", "job.log");
			process.env.DG_CLI_RECORD = record;
			const loaded = config();
			const expected = runnerCommand(
				name,
				join(binDir, name),
				{ task: "thrash", url: URL, comment: false, cwd: work },
				loaded,
			).slice(1);
			const result = await runnersFor(name)[name].run(runRequest(work, logPath));
			expect(result).toMatchObject({ status: 0, timedOut: false, aborted: false });
			expect(result.code).toBeUndefined();
			const seen = invocations(record);
			expect(seen).toHaveLength(1);
			expect(seen[0]?.args).toEqual(expected);
			expect(seen[0]?.cwd).toBe(work);
			expect(seen[0]?.env.PATH).toBe(binDir);
			expect(seen[0]?.env.CLAUDECODE).toBeNull();
			expect(seen[0]?.env.CLAUDE_CODE_ENTRYPOINT).toBeNull();
			expect(seen[0]?.env.CLAUDE_PID).toBeNull();
			expect(seen[0]?.env.CLAUDE_EFFORT).toBeNull();
			expect(seen[0]?.env.AI_AGENT).toBeNull();
			expect(seen[0]?.env.CHANNEL_REVIEW_KEEP).toBe("yes");
			expect(seen[0]?.env.XAI_API_KEY).toBe("xai-secret");
			expect(seen[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(name === "claude" ? "oauth-secret" : null);
			const log = readFileSync(logPath, "utf8");
			const hello = log.indexOf('{"type":"text","data":"Hello"}');
			const review = log.indexOf('{"type":"text","data":" review"}');
			const end = log.indexOf('{"type":"end","stopReason":"EndTurn"');
			expect(hello).toBeGreaterThanOrEqual(0);
			expect(hello).toBeLessThan(review);
			expect(review).toBeLessThan(end);
			expect(log).toContain("stderr-note");
		},
	);

	test.each(["claude", "grok"] as const)(
		"%s probe is ok when the fixture is signed in and thrash is installed",
		async (name) => {
			expect(await runnersFor(name)[name].probe()).toEqual({ ok: true });
		},
	);

	test.each(["claude", "grok"] as const)(
		"%s probe returns CR-202 when the fixture is not signed in",
		async (name) => {
			process.env.DG_CLI_MODE = "logged-out";
			expect(await runnersFor(name)[name].probe()).toEqual({ ok: false, code: "CR-202" });
		},
	);

	test.each(["claude", "grok"] as const)(
		"%s run returns CR-202 when the fixture exits with a sign-in error",
		async (name) => {
			process.env.DG_CLI_MODE = "logged-out";
			const result = await runnersFor(name)[name].run(
				runRequest(join(root, "work"), join(root, "logs", "job.log")),
			);
			expect(result.code).toBe("CR-202");
			expect(result.status).toBe(1);
		},
	);

	test("grok probe returns CR-202 when grok models exits 0 and says it is not authenticated", async () => {
		process.env.DG_CLI_MODE = "unauth-zero";
		expect(await runnersFor("grok").grok.probe()).toEqual({ ok: false, code: "CR-202" });
	});

	test("grok run returns CR-202 when the sign-in error is a streaming-json event", async () => {
		process.env.DG_CLI_MODE = "stdout-auth";
		const result = await runnersFor("grok").grok.run(
			runRequest(join(root, "work"), join(root, "logs", "job.log")),
		);
		expect(result.code).toBe("CR-202");
		expect(result.status).toBe(1);
	});

	test("claude run returns CR-202 when print mode writes the sign-in line to stdout", async () => {
		process.env.DG_CLI_MODE = "stdout-login";
		const result = await runnersFor("claude").claude.run(
			runRequest(join(root, "work"), join(root, "logs", "job.log")),
		);
		expect(result.code).toBe("CR-202");
		expect(result.status).toBe(1);
	});

	test("claude does not treat a stdout json event as a sign-in failure", async () => {
		process.env.DG_CLI_MODE = "stdout-auth";
		const result = await runnersFor("claude").claude.run(
			runRequest(join(root, "work"), join(root, "logs", "job.log")),
		);
		expect(result.code).toBeUndefined();
		expect(result.status).toBe(1);
		expect(readFileSync(join(root, "logs", "job.log"), "utf8")).toContain("Not logged in");
	});

	test.each(["claude", "grok"] as const)("%s passes the fixture exit status through", async (name) => {
		process.env.DG_CLI_MODE = "exit";
		process.env.DG_CLI_EXIT = "4";
		const result = await runnersFor(name)[name].run(
			runRequest(join(root, "work"), join(root, "logs", "job.log")),
		);
		expect(result).toMatchObject({ status: 4, timedOut: false, aborted: false });
		expect(result.code).toBeUndefined();
	});

	test.each(["claude", "grok"] as const)("%s reports the signal when the fixture kills itself", async (name) => {
		process.env.DG_CLI_MODE = "signal";
		const result = await runnersFor(name)[name].run(
			runRequest(join(root, "work"), join(root, "logs", "job.log")),
		);
		expect(result.timedOut).toBe(false);
		expect(result.signal).toBe("SIGTERM");
	});

	test.each(["claude", "grok"] as const)("%s times out and stops the fixture", async (name) => {
		process.env.DG_CLI_MODE = "sleep";
		const pids: number[] = [];
		const result = await runnersFor(name)[name].run({
			...runRequest(join(root, "work"), join(root, "logs", "job.log")),
			timeoutMs: 400,
			onSpawn: (pid) => pids.push(pid),
		});
		expect(result.timedOut).toBe(true);
		expect(result.aborted).toBe(false);
		expect(pids).toHaveLength(1);
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && isAlive(pids[0] as number)) {
			await Bun.sleep(25);
		}
		expect(isAlive(pids[0] as number)).toBe(false);
	});

	test.each(["claude", "grok"] as const)(
		"%s returns CR-201 when the executable is not on PATH",
		async (name) => {
			process.env.PATH = join(root, "empty");
			mkdirSync(process.env.PATH);
			const runners = runnersFor(name);
			expect(await runners[name].probe()).toEqual({ ok: false, code: "CR-201" });
			const result = await runners[name].run(
				runRequest(join(root, "work"), join(root, "logs", "job.log")),
			);
			expect(result.code).toBe("CR-201");
			expect(existsSync(join(root, "logs", "job.log"))).toBe(false);
		},
	);

	test.each(["claude", "grok"] as const)(
		"%s returns CR-201 when the configured path is missing",
		async (name) => {
			const runners = runnersFor(name, { [name]: { path: join(root, "missing-bin") } });
			const result = await runners[name].run(
				runRequest(join(root, "work"), join(root, "logs", "job.log")),
			);
			expect(result.code).toBe("CR-201");
			expect(result.status).toBeNull();
		},
	);
});
