import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./git-repo-fixtures";
import { collectRun, type SpecRun } from "./spec-fixtures";

const ENTRY = join(import.meta.dir, "../src/index.ts");
const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");

interface Session {
	pid: number;
	port: number;
	sentinelDir: string;
	cwd: string;
}

let root: string;
let scratch: string;
let outside: string;
const children: Array<{ kill(): void }> = [];

beforeEach(() => {
	root = makeTempDir("dg-prototype-ui-");
	scratch = join(root, "scratch");
	outside = join(root, "outside");
	mkdirSync(scratch, { recursive: true });
	mkdirSync(outside, { recursive: true });
});

afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	for (const chain of [
		"round",
		"series",
		"solo",
		"idle",
		"pinned",
		"plan-chain",
	]) {
		const state = readState(chain);
		if (state) {
			try {
				process.kill(state.pid, "SIGKILL");
			} catch {
				continue;
			}
		}
	}
	rmSync(root, { recursive: true, force: true });
});

function env(): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		AI_SCRATCH_DIR: scratch,
		DG_SKILLS_DIR: SKILLS,
		PROTOTYPE_UI_NO_OPEN: "1",
	};
}

function cli(args: string[], cwd = outside) {
	const proc = Bun.spawn([process.execPath, ENTRY, "prototype", ...args], {
		cwd,
		env: env(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(proc);
	return { proc, done: collectRun(proc) as Promise<SpecRun> };
}

function readState(chain: string): Session | undefined {
	try {
		return JSON.parse(
			readFileSync(join(scratch, "prototype-ui", `${chain}.json`), "utf8"),
		) as Session;
	} catch {
		return undefined;
	}
}

async function sessionFor(chain: string, previous?: Session): Promise<Session> {
	for (let i = 0; i < 100; i++) {
		const state = readState(chain);
		if (state && state.pid !== previous?.pid) return state;
		await Bun.sleep(100);
	}
	throw new Error(`no session for ${chain}`);
}

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function exited(pid: number): Promise<boolean> {
	for (let i = 0; i < 50; i++) {
		if (!running(pid)) return true;
		await Bun.sleep(100);
	}
	return false;
}

function manifest(
	name: string,
	chain?: string,
	body = "::: A\n<h1>Alpha</h1>\n:::\n::: B\n<h1>Beta</h1>\n:::\n",
): string {
	const path = join(root, `${name}.md`);
	writeFileSync(
		path,
		`---\nname: ${name}\n${chain ? `chain: ${chain}\n` : ""}labels:\n  A: Alpha\n---\n${body}`,
	);
	return path;
}

function decide(port: number, body: unknown) {
	return fetch(`http://127.0.0.1:${port}/prototype-decision`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Sec-Fetch-Site": "same-origin",
		},
		body: JSON.stringify(body),
	});
}

const port = () => 42000 + Math.floor(Math.random() * 2000);

setDefaultTimeout(30_000);

describe("prototype ui", () => {
	test("an approve with no notes prints one JSON line and tears the server and state down", async () => {
		const run = cli([
			"ui",
			manifest("solo"),
			"--no-open",
			`--port=${port()}`,
			"--timeout=30",
		]);
		const session = await sessionFor("solo");
		const page = await (
			await fetch(`http://127.0.0.1:${session.port}/`)
		).text();
		expect(page).toContain('data-variant="B"');
		expect(page).toContain("Alpha");
		await decide(session.port, { action: "confirm", variant: "B", notes: "" });
		const result = await run.done;
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			status: "ok",
			variant: "B",
			notes: "",
		});
		expect(await exited(session.pid)).toBe(true);
		expect(readState("solo")).toBeUndefined();
		expect(existsSync(join(session.sentinelDir, ".selection"))).toBe(false);
	});

	test("a reject keeps the server for the next round, which reuses it and clears stale decisions", async () => {
		const first = cli([
			"ui",
			manifest("round", undefined),
			"--no-open",
			`--port=${port()}`,
			"--timeout=60",
		]);
		const session = await sessionFor("round");
		await decide(session.port, { action: "reject", notes: "flatter" });
		expect(JSON.parse((await first.done).stdout)).toEqual({
			status: "rejected",
			notes: "flatter",
		});
		expect(running(session.pid)).toBe(true);

		const tokenBefore = readFileSync(
			join(session.sentinelDir, ".reload"),
			"utf8",
		);
		await Bun.sleep(20);
		const second = cli([
			"ui",
			manifest("round-2", "round"),
			"--no-open",
			"--timeout=60",
		]);
		await Bun.sleep(800);
		expect(readState("round")?.pid).toBe(session.pid);
		expect(readFileSync(join(session.sentinelDir, ".reload"), "utf8")).not.toBe(
			tokenBefore,
		);
		const html = await (
			await fetch(`http://127.0.0.1:${session.port}/`)
		).text();
		expect(html).toContain("<title>round-2</title>");
		await decide(session.port, {
			action: "confirm",
			variant: "A",
			notes: "tighten",
		});
		expect(JSON.parse((await second.done).stdout)).toEqual({
			status: "ok",
			variant: "A",
			notes: "tighten",
		});
		expect(running(session.pid)).toBe(true);

		const stopped = await cli(["stop", "round"]).done;
		expect(JSON.parse(stopped.stdout)).toEqual({
			status: "stopped",
			chain: "round",
			found: true,
		});
		expect(await exited(session.pid)).toBe(true);
		expect(JSON.parse((await cli(["stop", "round"]).done).stdout)).toEqual({
			status: "stopped",
			chain: "round",
			found: false,
		});
	});

	test("a series keeps the server after an approve with no notes", async () => {
		const run = cli([
			"ui",
			manifest("series"),
			"--series",
			"--no-open",
			`--port=${port()}`,
			"--timeout=60",
		]);
		const session = await sessionFor("series");
		expect(
			await (await fetch(`http://127.0.0.1:${session.port}/`)).text(),
		).toContain("__protoSeries=true");
		await decide(session.port, { action: "confirm", variant: "A", notes: "" });
		expect(JSON.parse((await run.done).stdout).status).toBe("ok");
		expect(running(session.pid)).toBe(true);
		await cli(["stop", "series"]).done;
		expect(await exited(session.pid)).toBe(true);
	});

	test("wait from an unrelated cwd claims a decision stored for the pinned session", async () => {
		const first = cli(
			[
				"ui",
				manifest("pinned"),
				"--no-open",
				`--port=${port()}`,
				"--timeout=60",
			],
			root,
		);
		const session = await sessionFor("pinned");
		first.proc.kill();
		await first.done;
		expect(session.cwd.startsWith(join(scratch, "prototype-ui"))).toBe(true);
		await decide(session.port, {
			action: "confirm",
			variant: "B",
			notes: "kept",
		});

		const ambient = join(root, "ambient");
		mkdirSync(ambient, { recursive: true });
		expect((await cli(["status", "pinned"], ambient).done).stdout).toBe("B\n");
		const claimed = await cli(["wait", "pinned", "--timeout=5"], ambient).done;
		expect(claimed.exitCode).toBe(0);
		expect(JSON.parse(claimed.stdout)).toEqual({
			status: "ok",
			variant: "B",
			notes: "kept",
		});
		await cli(["stop", "pinned"]).done;
	});

	test("without a session, wait and status fall back to the sentinels under the cwd", async () => {
		const confirmed = await cli(["confirm", "raw", "C", "--notes=n"]).done;
		expect(confirmed.exitCode).toBe(0);
		expect((await cli(["status", "raw"]).done).stdout).toBe("C\n");
		expect((await cli(["wait", "raw", "--json"]).done).stdout).toBe(
			'{"status":"ok","variant":"C","notes":"n"}\n',
		);
		const timed = await cli(["wait", "raw", "--timeout=1"]).done;
		expect(timed.exitCode).toBe(1);
		expect(timed.stdout).toBe("timeout\n");
	});

	test("status falls back to an unclaimed --ext verdict when no local sentinel is pending", async () => {
		const slug = "ext-fallback-demo";
		expect((await cli(["status", slug]).done).stdout).toBe("pending\n");

		const verdictDir = join(scratch, "proto", slug);
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(
			join(verdictDir, "verdict.json"),
			JSON.stringify({
				slug,
				action: "approve",
				selectedKey: "detailed",
				ts: 1_721_234_568_000,
			}),
		);
		expect((await cli(["status", slug]).done).stdout).toBe(
			"approve:detailed\n",
		);

		writeFileSync(
			join(verdictDir, "verdict.json"),
			JSON.stringify({
				slug,
				action: "reject",
				selectedKey: "detailed",
				feedback: "too busy",
				ts: 1_721_234_568_001,
			}),
		);
		expect((await cli(["status", slug]).done).stdout).toBe("rejected\n");
	});

	test("status prefers a real local sentinel over an unclaimed --ext verdict", async () => {
		const slug = "ext-fallback-wins-demo";
		const verdictDir = join(scratch, "proto", slug);
		mkdirSync(verdictDir, { recursive: true });
		writeFileSync(
			join(verdictDir, "verdict.json"),
			JSON.stringify({
				slug,
				action: "approve",
				selectedKey: "detailed",
				ts: 1_721_234_568_000,
			}),
		);
		await cli(["confirm", slug, "B"]).done;
		expect((await cli(["status", slug]).done).stdout).toBe("B\n");
	});

	test("status --json reports the recorded source, and --require-pending fails loudly on a stale pick", async () => {
		const name = "hand-over-demo";
		const pending = await cli(["status", name, "--require-pending"]).done;
		expect(pending.exitCode).toBe(0);
		expect(pending.stdout).toBe("pending\n");

		await cli(["confirm", name, "B", "--notes=ship it"]).done;
		expect(JSON.parse((await cli(["status", name, "--json"]).done).stdout)).toEqual({
			status: "B",
			source: "cli",
		});

		const stale = await cli(["status", name, "--require-pending"]).done;
		expect(stale.exitCode).toBe(1);
		expect(stale.stdout).toBe("");
		expect(stale.stderr).toMatch(/not "pending"/);
	});

	test("--require-pending does not consume the pick it refuses to report", async () => {
		const name = "hand-over-no-consume-demo";
		await cli(["confirm", name, "B", "--notes=ship it"]).done;
		await cli(["status", name, "--require-pending"]).done;
		expect((await cli(["wait", name, "--json"]).done).stdout).toBe(
			'{"status":"ok","variant":"B","notes":"ship it"}\n',
		);
	});

	test("confirm --source=TEXT records that value as the source", async () => {
		const name = "source-override-demo";
		await cli(["confirm", name, "B", "--source=automation"]).done;
		expect(JSON.parse((await cli(["status", name, "--json"]).done).stdout)).toEqual({
			status: "B",
			source: "automation",
		});
	});

	test("confirm --selftest writes to <name>-selftest, never the real name's sentinel or waiter", async () => {
		const name = "selftest-demo";
		await cli(["confirm", name, "Z", "--selftest", "--notes=automated click"]).done;

		expect((await cli(["status", name]).done).stdout).toBe("pending\n");
		const timedOut = await cli(["wait", name, "--timeout=1"]).done;
		expect(timedOut.exitCode).toBe(1);
		expect(timedOut.stdout).toBe("timeout\n");

		expect((await cli(["status", `${name}-selftest`]).done).stdout).toBe("Z\n");
	});

	test("times out with status 1 and a timeout line when nothing is decided", async () => {
		const run = cli([
			"ui",
			manifest("idle"),
			"--no-open",
			`--port=${port()}`,
			"--timeout=1",
		]);
		const result = await run.done;
		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({ status: "timeout" });
		const session = readState("idle");
		if (session) expect(await exited(session.pid)).toBe(true);
	});

	test("renders a ProtoPlan with labels and scoped styles from the shared format", async () => {
		const plan = {
			slug: "plan-chain",
			question: "Which card works?",
			mode: "replace",
			variations: [
				{
					key: "compact",
					label: "Compact",
					html: "<p>Compact</p>",
					css: "p { color: red; }",
				},
				{ key: "wide", label: "Wide", html: "<p>Wide</p>", css: "" },
			],
		};
		const path = join(root, "plan.json");
		writeFileSync(path, JSON.stringify(plan));
		const run = cli([
			"ui",
			path,
			"--no-open",
			`--port=${port()}`,
			"--timeout=30",
		]);
		const session = await sessionFor("plan-chain");
		const page = await (
			await fetch(`http://127.0.0.1:${session.port}/`)
		).text();
		expect(page).toContain("<title>Which card works?</title>");
		expect(page).toContain('data-variant="compact"');
		expect(page).toContain('@scope ([data-variant="compact"])');
		expect(page).toContain('"compact":"Compact"');
		await decide(session.port, {
			action: "confirm",
			variant: "wide",
			notes: "",
		});
		expect(JSON.parse((await run.done).stdout).variant).toBe("wide");
	});

	test.each([
		[
			"missing name",
			"---\nfoo: x\n---\n::: A\nx\n:::\n",
			/missing required frontmatter field "name"/,
		],
		[
			"unterminated frontmatter",
			"---\nname: x\n::: A\nx\n:::\n",
			/unterminated frontmatter/,
		],
		[
			"unterminated variant",
			"---\nname: x\n---\n::: A\nx\n",
			/missing its closing/,
		],
		["no variants", "---\nname: x\n---\n", /no variant content/],
	])("rejects a manifest with %s before serving", async (_label, body, message) => {
		const path = join(root, "bad.md");
		writeFileSync(path, body);
		const result = await cli(["ui", path, "--no-open"]).done;
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toMatch(message);
		expect(existsSync(join(scratch, "prototype-ui", "x.json"))).toBe(false);
	});

	describe("chain names that escape the state directory", () => {
		const names = [
			"../../x",
			"/tmp/dg-abs-x",
			"a/../../x",
			"..%2f..%2fx",
			"..%5c..%5cx",
			"x\\y",
		];

		test.each(names)("ui refuses --chain=%s before writing anything", async (name) => {
			const result = await cli([
				"ui",
				manifest("esc"),
				`--chain=${name}`,
				"--no-open",
			]).done;
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("invalid prototype name");
			expect(existsSync(join(root, "x.html"))).toBe(false);
			expect(existsSync(join(root, "x.json"))).toBe(false);
			expect(existsSync("/tmp/dg-abs-x.html")).toBe(false);
		});

		test.each(names)("ui refuses a manifest chain of %s", async (name) => {
			const result = await cli([
				"ui",
				manifest("esc", JSON.stringify(name)),
				"--no-open",
			]).done;
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("invalid prototype name");
			expect(existsSync(join(root, "x.html"))).toBe(false);
		});

		test.each(names)("stop refuses %s and deletes nothing", async (name) => {
			const victim = join(root, "x.json");
			writeFileSync(
				victim,
				JSON.stringify({ name: "x", sentinelDir: outside, htmlPath: victim }),
			);
			const result = await cli(["stop", name]).done;
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("invalid prototype name");
			expect(existsSync(victim)).toBe(true);
		});
	});

	test("an unknown option and a missing manifest are usage errors", async () => {
		const unknown = await cli(["ui", "m.md", "--bogus"]).done;
		expect(unknown.exitCode).toBe(1);
		expect(unknown.stderr).toContain("Unknown option: --bogus");
		expect((await cli(["ui"]).done).exitCode).toBe(1);
	});

	test("accepts a manifest on stdin", async () => {
		const proc = Bun.spawn(
			[
				process.execPath,
				ENTRY,
				"prototype",
				"ui",
				"-",
				"--no-open",
				`--port=${port()}`,
				"--timeout=30",
			],
			{
				cwd: outside,
				env: env(),
				stdin: new Blob(["---\nname: solo\n---\n<h1>Piped</h1>\n"]),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		children.push(proc);
		const done = collectRun(proc);
		const session = await sessionFor("solo");
		expect(
			await (await fetch(`http://127.0.0.1:${session.port}/`)).text(),
		).toContain("Piped");
		await decide(session.port, { action: "confirm", variant: "A", notes: "" });
		expect((await done).exitCode).toBe(0);
	});
});
