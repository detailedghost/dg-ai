import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { createFixFlow } from "../src/automation/fix-flow";
import { createNotifier } from "../src/automation/notify";
import { createRepoJobRunner } from "../src/automation/repo-job";
import { normalizeRepoTag } from "../src/automation/repos";
import { replyText } from "../src/errors";
import { createRunners } from "../src/runners";
import type { ErrorReport } from "../src/sinks/types";
import { createStateStore } from "../src/state";
import type { CaptureFn } from "../src/verdict/cli";
import {
	abortable,
	buildIssue,
	createEngineHarness,
	deferred,
	OK_RESULT,
	type RunnerResult,
	type RunnerRun,
	waitUntil,
} from "./support/fakes";

type Call = { command: string; args: string[]; cwd?: string };
type Behavior = {
	status?: string;
	head?: string;
	failOn?: string;
	prUrl?: string;
};

const BRANCH = "bot/fix/datadog-abc-1";
const PR_URL = "https://github.com/example-org/app/pull/9";
const REPO_CONFIG = { "example-api": { repo: "github.com/example-org/app" } };
const SUBJECT = "fix(example-api): Error abc/1";

const harnesses: ReturnType<typeof createEngineHarness>[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

function report(overrides: Partial<ErrorReport> = {}): ErrorReport {
	return {
		...buildIssue("abc/1"),
		message: "boom",
		stack: "at run (app.ts:1)",
		...overrides,
	};
}

function setup(
	options: {
		errorWatch?: Record<string, unknown>;
		behavior?: Behavior;
		openPrs?: { url: string; headRefName: string }[];
		script?: (run: RunnerRun) => RunnerResult | Promise<RunnerResult>;
	} = {},
) {
	const behavior = options.behavior ?? {};
	const order: string[] = [];
	const h = createEngineHarness({
		configExtra: { errorWatch: { repos: REPO_CONFIG, ...options.errorWatch } },
		runnerScript: (run) => {
			order.push("claude");
			return options.script ? options.script(run) : OK_RESULT;
		},
	});
	harnesses.push(h);
	const calls: Call[] = [];
	const run = (async (
		command: string,
		args: string[],
		opts?: { cwd?: string },
	) => {
		calls.push({ command, args, cwd: opts?.cwd });
		order.push(`${command} ${args.slice(0, 2).join(" ")}`);
		const key = `${command} ${args[0]}`;
		const result = (stdout = "") => ({
			status: 0,
			signal: null,
			stdout,
			stderr: "",
		});
		if (behavior.failOn === key)
			return { status: 1, signal: null, stdout: "", stderr: "denied" };
		if (command === "gh" && args[0] === "repo") {
			mkdirSync(args[3] as string, { recursive: true });
			return result();
		}
		if (key === "git status")
			return result(behavior.status ?? " M src/app.ts\n");
		if (key === "git rev-parse") return result(`${behavior.head ?? BRANCH}\n`);
		if (key === "gh pr") return result(`${behavior.prUrl ?? PR_URL}\n`);
		return result();
	}) as CaptureFn;
	const realNotify = createNotifier({
		provider: h.provider,
		config: h.config,
		log: h.log,
	});
	const notify: typeof realNotify = async (text, link) => {
		order.push("dm");
		await realNotify(text, link);
	};
	const flow = createFixFlow({
		state: h.state,
		config: h.config,
		notify,
		repos: {
			defaultBranch: async () => "main",
			openPrs: async () =>
				(options.openPrs ?? []).map((pr) => ({
					...pr,
					isDraft: true,
					createdAt: "2026-10-14T00:00:00Z",
				})),
			prStatus: async () => ({ state: "OPEN", isDraft: true, checks: [] }),
			markReady: async () => {},
		},
		runRepoJob: createRepoJobRunner({
			capture: run,
			cloneRoot: h.config.automation.cloneRoot,
			log: h.log,
			suffix: () => "sfx",
		}),
		run,
		enqueue: (job) => h.engine.enqueueRepo(job),
		clock: h.clock,
		log: h.log,
	});
	const dms = () => h.provider.dms.map((dm) => dm.text);
	return { h, flow, calls, order, dms };
}

describe("handleIssue", () => {
	test("runs the whole flow in order and DMs the draft PR link", async () => {
		const { h, flow, order, calls, dms } = setup();
		await flow.handleIssue("datadog", report());
		await h.engine.idle();

		expect(order).toEqual([
			"dm",
			"gh repo clone",
			"git checkout -b",
			"claude",
			"git status --porcelain",
			"git add -A",
			"git commit -m",
			"git rev-parse --abbrev-ref",
			"git push -u",
			"gh pr create",
			"dm",
		]);
		expect(calls.find((c) => c.args[0] === "commit")?.args).toEqual([
			"commit",
			"-m",
			SUBJECT,
		]);
		expect(calls.find((c) => c.args[0] === "push")?.args).toEqual([
			"push",
			"-u",
			"origin",
			BRANCH,
		]);
		const create = calls.find((c) => c.args[0] === "pr")?.args ?? [];
		expect(create).toContain("--draft");
		expect(create[create.indexOf("--body") + 1]).toContain(
			"Review before merging; this PR was generated from production error data.",
		);
		expect(h.state.get().issues["datadog:abc/1"]).toMatchObject({
			status: "pr-open",
			prUrl: PR_URL,
		});
		expect(dms()[1]).toContain(PR_URL);
		expect(h.state.get().fixStarts).toHaveLength(1);
		expect(readdirSync(h.config.automation.cloneRoot)).toEqual([]);
	});

	test("writes a capped, sanitized report outside the clone", async () => {
		let seen:
			| { path: string; cwd: string; body: Record<string, string> }
			| undefined;
		const { h, flow } = setup({
			script: (run) => {
				if (run.task !== "fix") throw new Error("unexpected task");
				const path = run.reportPath;
				seen = {
					path,
					cwd: run.cwd,
					body: JSON.parse(readFileSync(path, "utf8")),
				};
				return OK_RESULT;
			},
		});
		await flow.handleIssue(
			"datadog",
			report({
				title: `T${"x".repeat(400)}\u0007`,
				message: "m".repeat(3000),
				stack: `s\u0000${"y".repeat(9000)}`,
			}),
		);
		await h.engine.idle();

		expect(dirname(seen?.path ?? "")).toBe(h.config.automation.cloneRoot);
		expect(seen?.path.startsWith(`${seen?.cwd}${sep}`)).toBe(false);
		expect(seen?.body.title).toHaveLength(300);
		expect(seen?.body.title).not.toContain("\u0007");
		expect(seen?.body.message).toHaveLength(2000);
		expect(seen?.body.stack).toHaveLength(8000);
		expect(seen?.body.stack).not.toContain("\u0000");
		expect(existsSync(seen?.path ?? "")).toBe(false);
	});

	test("builds claude argv from the fixed prompt and never includes the report text", async () => {
		const { h } = setup();
		let argv: string[] = [];
		const runners = createRunners(h.config, {
			which: () => "/bin/claude",
			runProcess: async (request) => {
				argv = request.argv;
				return {
					status: 0,
					signal: null,
					timedOut: false,
					aborted: false,
					outputTail: "",
					stderrTail: "",
				};
			},
		});
		await runners.claude.run({
			task: "fix",
			reportPath: "/clones/x.report.json",
			cwd: "/clones/x",
			timeoutMs: 1000,
			logPath: join(h.home.dir, "x.log"),
			signal: new AbortController().signal,
		});
		expect(argv.slice(1, 3)).toEqual([
			"-p",
			"Fix the error described in the JSON file at /clones/x.report.json. Make the smallest change that fixes the root cause and add a regression test. Do not commit or push.",
		]);
		expect(argv).toContain("--append-system-prompt");
		expect(argv.join(" ")).toContain("--permission-mode dontAsk");
		expect(argv.slice(argv.indexOf("--allowedTools") + 1)).toEqual(
			h.config.errorWatch.autoFix.allowedTools,
		);
	});

	test("skips an issue that is already known", async () => {
		const { h, flow, calls, dms } = setup();
		h.state.setIssue("datadog:abc/1", {
			status: "pr-open",
			firstSeen: "2026-10-14T11:00:00Z",
		});
		await flow.handleIssue("datadog", report());
		await h.engine.idle();
		expect(dms()).toEqual([]);
		expect(calls).toEqual([]);
	});

	test.each([
		["autoFix is off globally", { autoFix: { enabled: false } }],
		[
			"autoFix is off for the service",
			{
				repos: {
					"example-api": { repo: "github.com/example-org/app", autoFix: false },
				},
			},
		],
	])("only notifies when %s", async (_name, errorWatch) => {
		const { h, flow, calls, dms } = setup({ errorWatch });
		await flow.handleIssue("datadog", report());
		await h.engine.idle();
		expect(dms()).toHaveLength(1);
		expect(calls).toEqual([]);
		expect(h.state.get().issues["datadog:abc/1"]?.status).toBe("notified");
	});

	test("DMs CR-401 and marks failed when the service has no allowed repo", async () => {
		const { h, flow, calls, dms } = setup();
		await flow.handleIssue("datadog", report({ service: "other-svc" }));
		await h.engine.idle();
		expect(dms()[1]).toStartWith("CR-401");
		expect(calls).toEqual([]);
		expect(h.state.get().issues["datadog:abc/1"]?.status).toBe("failed");
	});

	test("prefers the repo tag when it matches an allowed repo and falls back to the service otherwise", async () => {
		const errorWatch = {
			repos: {
				...REPO_CONFIG,
				lib: { repo: "github.com/example-org/lib", branch: "develop" },
			},
		};
		const tagged = setup({ errorWatch });
		await tagged.flow.handleIssue(
			"datadog",
			report({ repoTag: "git@github.com:Example-Org/lib.git" }),
		);
		await tagged.h.engine.idle();
		const clone = tagged.calls.find((c) => c.args[0] === "repo")?.args ?? [];
		expect(clone[2]).toBe("github.com/example-org/lib");
		expect(clone).toContain("develop");

		const fallback = setup({ errorWatch });
		await fallback.flow.handleIssue(
			"datadog",
			report({ repoTag: "https://github.com/evil/repo.git" }),
		);
		await fallback.h.engine.idle();
		expect(fallback.calls.find((c) => c.args[0] === "repo")?.args[2]).toBe(
			"github.com/example-org/app",
		);
	});

	test("defers at the hourly cap, DMs CR-402 once, and retries after the hour passes", async () => {
		const { h, flow, calls, dms } = setup();
		h.state.recordFixStart();
		h.state.recordFixStart();
		await flow.handleIssue("datadog", report());
		await flow.handleIssue("datadog", report());
		expect(h.state.get().issues["datadog:abc/1"]?.status).toBe("deferred");
		expect(dms().filter((text) => text.startsWith("CR-402"))).toHaveLength(1);
		expect(dms()).toHaveLength(2);
		expect(calls).toEqual([]);

		h.clock.advance(61 * 60_000);
		await flow.handleIssue("datadog", report());
		await h.engine.idle();
		expect(h.state.get().issues["datadog:abc/1"]?.status).toBe("pr-open");
		expect(dms().filter((text) => text.startsWith("New "))).toHaveLength(1);
	});

	test("DMs CR-403 and records the PR when a bot PR is already open", async () => {
		const { h, flow, calls, dms } = setup({
			openPrs: [{ url: PR_URL, headRefName: BRANCH }],
		});
		await flow.handleIssue("datadog", report());
		await h.engine.idle();
		expect(dms()[1]).toStartWith("CR-403");
		expect(calls).toEqual([]);
		expect(h.state.get().issues["datadog:abc/1"]).toMatchObject({
			status: "pr-open",
			prUrl: PR_URL,
		});
	});

	test("reports CR-404 and commits nothing when the agent changed nothing", async () => {
		const { h, flow, calls, dms } = setup({ behavior: { status: "" } });
		await flow.handleIssue("datadog", report());
		await h.engine.idle();
		expect(dms()[1]).toStartWith("CR-404");
		expect(calls.map((c) => c.args[0])).not.toContain("add");
		expect(h.state.get().issues["datadog:abc/1"]?.status).toBe("failed");
	});

	test.each([
		["the branch is not the bot branch", "other"],
		["the branch is the default branch", "main"],
	])("reports CR-405 and never pushes when %s", async (_name, head) => {
		const { h, flow, calls, dms } = setup({ behavior: { head } });
		await flow.handleIssue("datadog", report());
		await h.engine.idle();
		expect(dms()[1]).toStartWith("CR-405");
		expect(calls.map((c) => c.args[0])).not.toContain("push");
		expect(h.state.get().issues["datadog:abc/1"]?.status).toBe("failed");
	});

	test("reports CR-405 when the push fails", async () => {
		const { h, flow, dms } = setup({ behavior: { failOn: "git push" } });
		await flow.handleIssue("datadog", report());
		await h.engine.idle();
		expect(dms()[1]).toStartWith("CR-405");
	});

	test("reports CR-205 when the daemon stops during the agent run", async () => {
		const gate = deferred<RunnerResult>();
		const { h, flow, dms } = setup({
			script: (run) => abortable(run, gate.promise),
		});
		await flow.handleIssue("datadog", report());
		await waitUntil(() => h.runner.runs.length === 1);
		await h.engine.stop();
		expect(dms()[1]).toBe(`${replyText("CR-205")}\n${report().link}`);
		expect(h.state.get().issues["datadog:abc/1"]?.status).toBe("failed");
	});
});

describe("recover with repo jobs", () => {
	test("sweeps the clone root, fails fixing issues, and DMs CR-205", async () => {
		const { h } = setup();
		const root = h.config.automation.cloneRoot;
		mkdirSync(join(root, "fix-datadog-1-sfx"), { recursive: true });
		writeFileSync(join(root, "fix-datadog-1-sfx.report.json"), "{}");
		h.state.setIssue("datadog:1", {
			status: "fixing",
			firstSeen: "2026-10-14T11:00:00Z",
		});
		h.state.setIssue("datadog:2", {
			status: "pr-open",
			firstSeen: "2026-10-14T11:00:00Z",
		});

		await h.engine.recover({
			isAlive: () => false,
			listArgs: () => "",
			startTime: () => undefined,
			killTree: () => undefined,
		});

		expect(readdirSync(root)).toEqual([]);
		expect(h.state.get().issues["datadog:1"]?.status).toBe("failed");
		expect(h.state.get().issues["datadog:2"]?.status).toBe("pr-open");
		expect(h.provider.dms).toHaveLength(1);
		expect(h.provider.dms[0]?.text).toStartWith("CR-205");
		expect(h.provider.calls).toEqual([]);
	});
});

describe("fix start persistence", () => {
	test("keeps fixStarts across a state reload", () => {
		const { h } = setup();
		h.state.recordFixStart();
		const reloaded = h.home.track(createStateStore(h.paths, h.clock));
		expect(reloaded.get().fixStarts).toEqual([h.clock().toISOString()]);
	});
});

describe("normalizeRepoTag", () => {
	test.each([
		"https://github.com/Example-Org/App.git",
		"git@github.com:example-org/app.git",
		"ssh://git@github.com/example-org/app",
		"github.com/example-org/app/",
	])("normalizes %s", (tag) => {
		expect(normalizeRepoTag(tag)).toBe("github.com/example-org/app");
	});

	test("returns undefined for a non-GitHub host or junk", () => {
		expect(
			normalizeRepoTag("https://gitlab.example.com/a/b.git"),
		).toBeUndefined();
		expect(normalizeRepoTag("nonsense")).toBeUndefined();
	});
});
