import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { createRunners } from "../src/runners";
import { RUNNER_NAMES, type RunnerName } from "../src/runners/types";
import {
	type TempHome,
	createTempHome,
	minimalConfigJson,
	writeConfigFile,
} from "./support/fakes";

const HOME = "/home/dev";
const URL = "https://github.com/o/r/pull/12";
const PATHS = {
	claude: "/bin/claude",
	codex: "/bin/codex",
	copilot: "/bin/copilot",
} as const;

type Capture = {
	status: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};
type RunProcessFn = NonNullable<
	NonNullable<Parameters<typeof createRunners>[1]>["runProcess"]
>;
type ProcessRequest = Parameters<RunProcessFn>[0];
type ProcessResult = Awaited<ReturnType<RunProcessFn>>;

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => home.cleanup());

function configWith(runner: Record<string, unknown> = {}) {
	return loadConfig(
		writeConfigFile(home.dir, minimalConfigJson({ runner })),
	);
}

function fakeFs(files: string[]) {
	const all = new Set(files);
	return {
		exists: (path: string) =>
			all.has(path) || files.some((file) => file.startsWith(`${path}/`)),
		readdir: (path: string) => [
			...new Set(
				files
					.filter((file) => file.startsWith(`${path}/`))
					.map((file) => file.slice(path.length + 1).split("/")[0] as string),
			),
		],
	};
}

const SKILL_ROOTS: Record<RunnerName, string[]> = {
	claude: [
		`${HOME}/.claude/skills/thrash/SKILL.md`,
		`${HOME}/.claude/plugins/dg/skills/thrash/SKILL.md`,
		`${HOME}/.claude/plugins/cache/mkt/dg/1.2.0/skills/thrash/SKILL.md`,
	],
	codex: [
		`${HOME}/.codex/skills/thrash/SKILL.md`,
		`${HOME}/.agents/skills/thrash/SKILL.md`,
	],
	copilot: [
		`${HOME}/.copilot/skills/thrash/SKILL.md`,
		`${HOME}/.claude/skills/thrash/SKILL.md`,
	],
};


function harness(
	options: {
		config?: ReturnType<typeof configWith>;
		which?: (name: string) => string | undefined | null;
		files?: string[];
		capture?: (command: string, args: string[]) => Capture | Promise<Capture>;
		process?: (request: ProcessRequest) => ProcessResult;
		step?: number;
	} = {},
) {
	const captures: { command: string; args: string[]; options: unknown }[] = [];
	const processes: ProcessRequest[] = [];
	const whichCalls: string[] = [];
	let tick = 0;
	const step = options.step ?? 1000;
	const runners = createRunners(options.config ?? configWith(), {
		which: (name: string) => {
			whichCalls.push(name);
			return (options.which ?? ((n) => PATHS[n as RunnerName]))(name);
		},
		homedir: HOME,
		fs: fakeFs(options.files ?? Object.values(SKILL_ROOTS).flat()),
		now: () => {
			tick += step;
			return tick;
		},
		runCapture: async (command: string, args: string[], opts?: unknown) => {
			captures.push({ command, args, options: opts });
			return (
				(await options.capture?.(command, args)) ?? {
					status: 0,
					signal: null,
					stdout: "",
					stderr: "",
				}
			);
		},
		runProcess: async (request: ProcessRequest) => {
			processes.push(request);
			return (
				(await options.process?.(request)) ?? {
					status: 0,
					signal: null,
					timedOut: false,
					aborted: false,
					stderrTail: "",
				}
			);
		},
	});
	return { runners, captures, processes, whichCalls };
}

function runRequest(overrides: Record<string, unknown> = {}) {
	return {
		task: "thrash" as const,
		url: URL,
		comment: false,
		cwd: "/work",
		timeoutMs: 60_000,
		logPath: "/logs/job.log",
		signal: new AbortController().signal,
		...overrides,
	};
}

describe("createRunners", () => {
	test("returns one runner per runner name", () => {
		const { runners } = harness();
		expect(Object.keys(runners).sort()).toEqual([...RUNNER_NAMES].sort());
		for (const name of RUNNER_NAMES) expect(runners[name].name).toBe(name);
	});
});

describe("runner probe", () => {
	test.each([...RUNNER_NAMES])("%s returns ok when found, signed in, and thrash is installed", async (name) => {
		const { runners } = harness();
		expect(await runners[name].probe()).toEqual({ ok: true });
	});

	test.each([...RUNNER_NAMES])("%s returns CR-201 when the binary is not on PATH and never runs a CLI", async (name) => {
		const h = harness({ which: () => undefined });
		expect(await h.runners[name].probe()).toEqual({
			ok: false,
			code: "CR-201",
		});
		expect(h.captures).toEqual([]);
		expect(h.processes).toEqual([]);
	});

	test("uses the configured path override without asking which", async () => {
		const h = harness({
			config: configWith({ codex: { path: "/opt/codex" } }),
			which: () => undefined,
		});
		expect(await h.runners.codex.probe()).toEqual({ ok: true });
		expect(h.whichCalls).toEqual([]);
	});

	test("claude runs claude auth status and CR-202 follows a nonzero exit", async () => {
		const h = harness({
			capture: () => ({ status: 1, signal: null, stdout: "", stderr: "" }),
		});
		expect(await h.runners.claude.probe()).toEqual({
			ok: false,
			code: "CR-202",
		});
		expect(h.captures[0]).toMatchObject({
			command: PATHS.claude,
			args: ["auth", "status"],
			options: { timeoutMs: 60_000 },
		});
	});

	test("codex runs codex login status and CR-202 follows a nonzero exit", async () => {
		const h = harness({
			capture: () => ({ status: 1, signal: null, stdout: "", stderr: "" }),
		});
		expect(await h.runners.codex.probe()).toEqual({
			ok: false,
			code: "CR-202",
		});
		expect(h.captures[0]).toMatchObject({
			command: PATHS.codex,
			args: ["login", "status"],
		});
	});

	test("copilot has no status command and returns ok without a login call", async () => {
		const h = harness({
			capture: () => ({ status: 1, signal: null, stdout: "", stderr: "" }),
		});
		expect(await h.runners.copilot.probe()).toEqual({ ok: true });
		expect(h.captures).toEqual([]);
	});

	test.each([...RUNNER_NAMES])("%s returns CR-206 when no thrash/SKILL.md exists and never runs", async (name) => {
		const h = harness({ files: [`${HOME}/.claude/skills/other/SKILL.md`] });
		expect(await h.runners[name].probe()).toEqual({
			ok: false,
			code: "CR-206",
		});
		expect(h.processes).toEqual([]);
	});

	test.each(
		RUNNER_NAMES.flatMap((name) =>
			SKILL_ROOTS[name].map((file) => [name, file] as const),
		),
	)("%s finds thrash at %s", async (name, file) => {
		const { runners } = harness({ files: [file] });
		expect(await runners[name].probe()).toEqual({ ok: true });
	});

	test("claude does not see a thrash skill that exists only under codex roots", async () => {
		const { runners } = harness({
			files: [`${HOME}/.codex/skills/thrash/SKILL.md`],
		});
		expect(await runners.claude.probe()).toEqual({
			ok: false,
			code: "CR-206",
		});
	});

	test("checks the thrash skill only after the login check passes", async () => {
		const { runners } = harness({
			files: [],
			capture: () => ({ status: 1, signal: null, stdout: "", stderr: "" }),
		});
		expect(await runners.claude.probe()).toEqual({
			ok: false,
			code: "CR-202",
		});
	});
});

describe("runner run argv", () => {
	test("claude builds the thrash prompt with spice and comment as one element and the allowlist last", async () => {
		const config = configWith();
		const h = harness({ config });
		await h.runners.claude.run(runRequest({ spice: 3, comment: true }));
		expect(h.processes[0]?.argv).toEqual([
			PATHS.claude,
			"-p",
			`/thrash ${URL} -s 3 -c`,
			"--permission-prompts",
			"none",
			"--permission-mode",
			"dontAsk",
			"--allowedTools",
			...config.runner.claude.allowedTools,
		]);
	});

	test("claude omits -s and -c when neither is set", async () => {
		const h = harness();
		await h.runners.claude.run(runRequest());
		expect(h.processes[0]?.argv[2]).toBe(`/thrash ${URL}`);
	});

	test("claude uses a configured allowlist and path", async () => {
		const h = harness({
			config: configWith({
				claude: { path: "/opt/claude", allowedTools: ["Read", "Bash(gh:*)"] },
			}),
		});
		await h.runners.claude.run(runRequest());
		const argv = h.processes[0]?.argv ?? [];
		expect(argv[0]).toBe("/opt/claude");
		expect(argv.slice(-3)).toEqual(["--allowedTools", "Read", "Bash(gh:*)"]);
	});

	test("claude runs /address with the address allowlist", async () => {
		const config = configWith();
		const h = harness({ config });
		await h.runners.claude.run({ ...runRequest(), task: "address", noCi: false });
		expect(h.processes[0]?.argv).toEqual([
			PATHS.claude,
			"-p",
			"/address",
			"--permission-prompts",
			"none",
			"--permission-mode",
			"dontAsk",
			"--allowedTools",
			...config.runner.claude.addressAllowedTools,
		]);
	});

	test("claude passes --no-ci to /address when asked", async () => {
		const h = harness();
		await h.runners.claude.run({ ...runRequest(), task: "address", noCi: true });
		expect(h.processes[0]?.argv[2]).toBe("/address --no-ci");
	});

	test("codex builds the exec argv with the thrash skill prompt", async () => {
		const h = harness();
		await h.runners.codex.run(runRequest({ spice: 2 }));
		expect(h.processes[0]?.argv).toEqual([
			PATHS.codex,
			"exec",
			"--skip-git-repo-check",
			"-C",
			"/work",
			"--dangerously-bypass-approvals-and-sandbox",
			`Use the thrash skill: $thrash ${URL} -s 2`,
		]);
	});

	test("copilot builds the -p argv with the thrash skill prompt", async () => {
		const h = harness();
		await h.runners.copilot.run(runRequest({ comment: true }));
		expect(h.processes[0]?.argv).toEqual([
			PATHS.copilot,
			"-p",
			`Use the thrash skill: /thrash ${URL} -c`,
			"--allow-all-tools",
			"--no-ask-user",
			"-s",
		]);
	});

	test.each([...RUNNER_NAMES])("%s passes cwd, timeout, log path, signal, and onSpawn to runProcess", async (name) => {
		const h = harness();
		const spawned: number[] = [];
		const request = runRequest({
			onSpawn: (pid: number) => spawned.push(pid),
		});
		await h.runners[name].run(request);
		const sent = h.processes[0];
		expect(sent).toMatchObject({
			cwd: "/work",
			timeoutMs: 60_000,
			logPath: "/logs/job.log",
		});
		expect(sent?.signal).toBe(request.signal);
		sent?.onSpawn?.(4242);
		expect(spawned).toEqual([4242]);
	});
});

describe("runner run result", () => {
	test.each([...RUNNER_NAMES])("%s returns CR-201 without spawning when the binary is missing", async (name) => {
		const h = harness({ which: () => undefined });
		const result = await h.runners[name].run(runRequest());
		expect(result.code).toBe("CR-201");
		expect(h.processes).toEqual([]);
	});

	test("passes status, signal, timedOut, and aborted through", async () => {
		const h = harness({
			process: () => ({
				status: null,
				signal: "SIGKILL",
				timedOut: true,
				aborted: false,
				stderrTail: "",
			}),
		});
		const result = await h.runners.claude.run(runRequest());
		expect(result).toMatchObject({
			status: null,
			signal: "SIGKILL",
			timedOut: true,
			aborted: false,
		});
		expect(result.code).toBeUndefined();
	});

	test("passes a spawn error code CR-201 through", async () => {
		const h = harness({
			process: () => ({
				status: null,
				signal: null,
				timedOut: false,
				aborted: false,
				stderrTail: "",
				code: "CR-201",
			}),
		});
		const result = await h.runners.codex.run(runRequest());
		expect(result.code).toBe("CR-201");
	});

	test.each([
		"Invalid API key",
		"Please run /login",
		"Not logged in",
		"authentication failed",
		"401 Unauthorized",
	])("infers CR-202 from a fast nonzero exit with stderr %p", async (stderrTail) => {
		const h = harness({
			step: 5000,
			process: () => ({
				status: 1,
				signal: null,
				timedOut: false,
				aborted: false,
				stderrTail,
			}),
		});
		const result = await h.runners.claude.run(runRequest());
		expect(result.code).toBe("CR-202");
		expect(result.status).toBe(1);
	});

	test.each([
		["claude", "+ the handler prints: not logged in\n  and Not logged in appears mid-line"],
		["codex", "diff --git a/x b/x\n+throw new Error('not logged in')\n  Not logged in"],
		["copilot", "+ 401 Unauthorized\nthe user was not logged in"],
	] as const)("%s does not infer CR-202 from auth words inside echoed diff lines", async (name, stderrTail) => {
		const h = harness({
			step: 5000,
			process: () => ({
				status: 1,
				signal: null,
				timedOut: false,
				aborted: false,
				stderrTail,
			}),
		});
		const result = await h.runners[name].run(runRequest());
		expect(result.code).toBeUndefined();
	});

	test.each(["codex", "copilot"] as const)(
		"%s infers CR-202 from an error line the CLI prints",
		async (name) => {
			const h = harness({
				step: 5000,
				process: () => ({
					status: 1,
					signal: null,
					timedOut: false,
					aborted: false,
					stderrTail: "thinking...\nERROR: unexpected status 401 Unauthorized: missing bearer",
				}),
			});
			const result = await h.runners[name].run(runRequest());
			expect(result.code).toBe("CR-202");
		},
	);

	test("does not infer CR-202 when the run took longer than 60 s", async () => {
		const h = harness({
			step: 61_000,
			process: () => ({
				status: 1,
				signal: null,
				timedOut: false,
				aborted: false,
				stderrTail: "Not logged in",
			}),
		});
		const result = await h.runners.claude.run(runRequest());
		expect(result.code).toBeUndefined();
	});

	test("does not infer CR-202 from an unrelated stderr", async () => {
		const h = harness({
			step: 5000,
			process: () => ({
				status: 1,
				signal: null,
				timedOut: false,
				aborted: false,
				stderrTail: "segmentation fault",
			}),
		});
		const result = await h.runners.claude.run(runRequest());
		expect(result.code).toBeUndefined();
	});

	test("does not infer CR-202 when the run exits 0 with a matching stderr", async () => {
		const h = harness({
			step: 5000,
			process: () => ({
				status: 0,
				signal: null,
				timedOut: false,
				aborted: false,
				stderrTail: "Please run /login",
			}),
		});
		const result = await h.runners.claude.run(runRequest());
		expect(result.code).toBeUndefined();
	});

	test("does not infer CR-202 when stderr only mentions login code", async () => {
		const h = harness({
			step: 5000,
			process: () => ({
				status: 1,
				signal: null,
				timedOut: false,
				aborted: false,
				stderrTail: "TypeError: login page failed to authenticate the user",
			}),
		});
		const result = await h.runners.claude.run(runRequest());
		expect(result.code).toBeUndefined();
	});

	test.each([...RUNNER_NAMES])(
		"%s keeps CLAUDE_CODE_OAUTH_TOKEN only for the claude runner",
		async (name) => {
			const h = harness();
			await h.runners[name].run(runRequest());
			expect(h.processes[0]?.keepOauthToken).toBe(name === "claude");
		},
	);
});
