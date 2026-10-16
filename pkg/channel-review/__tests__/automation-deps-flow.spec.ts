import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDepsFlow } from "../src/automation/deps-flow";
import { createNotifier } from "../src/automation/notify";
import { createRepoJobRunner } from "../src/automation/repo-job";
import type { OpenPr } from "../src/automation/types";
import { replyText } from "../src/errors";
import type { CaptureFn } from "../src/verdict/cli";
import {
	createEngineHarness,
	OK_RESULT,
	type RunnerResult,
	type RunnerRun,
} from "./support/fakes";

const REPO = "github.com/example-org/app";
const PR_URL = "https://github.com/example-org/app/pull/12";
const WINDOW = { every: "day", window: "00:00-23:59" };

const harnesses: ReturnType<typeof createEngineHarness>[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

function setup(
	options: {
		deps?: Record<string, unknown>;
		existing?: Partial<OpenPr>[];
		script?: (run: RunnerRun, open: (pr: Partial<OpenPr>) => void) => RunnerResult;
	} = {},
) {
	const prs: OpenPr[] = [];
	const open = (pr: Partial<OpenPr>) =>
		prs.push({
			url: PR_URL,
			headRefName: "chore/deps-update-20261014",
			isDraft: true,
			createdAt: h.clock().toISOString(),
			...pr,
		});
	const h = createEngineHarness({
		runnerScript: (run) => options.script?.(run, open) ?? OK_RESULT,
		configExtra: {
			deps: {
				enabled: true,
				schedule: WINDOW,
				repos: [{ repo: REPO }],
				...options.deps,
			},
		},
	});
	harnesses.push(h);
	for (const pr of options.existing ?? []) open({ createdAt: "2026-10-01T00:00:00Z", ...pr });
	const calls: string[][] = [];
	const run = (async (_command: string, args: string[]) => {
		calls.push(args);
		if (args[0] === "repo") mkdirSync(args[3] as string, { recursive: true });
		return { status: 0, signal: null, stdout: "", stderr: "" };
	}) as CaptureFn;
	const notify = createNotifier({ provider: h.provider, config: h.config, log: h.log });
	const flow = createDepsFlow({
		state: h.state,
		config: h.config,
		notify,
		repos: {
			defaultBranch: async () => "main",
			openPrs: async () => [...prs],
			prStatus: async () => ({ state: "OPEN", isDraft: true, checks: [] }),
			markReady: async () => {},
		},
		runRepoJob: createRepoJobRunner({
			capture: run,
			cloneRoot: h.config.automation.cloneRoot,
			log: h.log,
			suffix: () => "sfx",
		}),
		enqueue: (job) => h.engine.enqueueRepo(job),
		jobsDir: h.paths.jobsDir,
		clock: h.clock,
		log: h.log,
	});
	const dms = () => h.provider.dms.map((dm) => dm.text);
	const tick = async () => {
		await flow.tick(new AbortController().signal);
		await h.engine.idle();
	};
	return { h, flow, tick, dms, calls };
}

describe("deps flow", () => {
	test("watches a new draft PR and DMs that it waits for CI", async () => {
		const s = setup({ script: (_run, open) => (open({}), OK_RESULT) });
		await s.tick();

		expect(s.dms()).toEqual([
			`Deps upgrade PR opened as draft for ${REPO}, waiting for CI:\n${PR_URL}`,
		]);
		expect(s.h.state.get().prWatch[PR_URL]).toMatchObject({ repo: REPO, kind: "deps" });
		expect(s.h.state.get().deps.lastRun[REPO]).toMatchObject({ result: "draft-pr" });
	});

	test("clones the default branch and passes the cooldown to the agent", async () => {
		const s = setup({ deps: { cooldownDays: 3 } });
		await s.tick();

		const clone = s.calls.find((args) => args[0] === "repo") ?? [];
		expect(clone.slice(-3)).toEqual(["--branch", "main", "--single-branch"]);
		expect(s.h.runner.runs).toHaveLength(1);
		expect(s.h.runner.runs[0]).toMatchObject({
			task: "deps",
			cooldownDays: 3,
			timeoutMs: 90 * 60_000,
		});
	});

	test("uses the configured branch over the default branch", async () => {
		const s = setup({ deps: { repos: [{ repo: REPO, branch: "develop" }] } });
		await s.tick();
		const clone = s.calls.find((args) => args[0] === "repo") ?? [];
		expect(clone).toContain("develop");
	});

	test("DMs ready when the skill already marked the PR ready", async () => {
		const s = setup({ script: (_run, open) => (open({ isDraft: false }), OK_RESULT) });
		await s.tick();

		expect(s.dms()).toEqual([`Deps upgrade ready for ${REPO}:\n${PR_URL}`]);
		expect(s.h.state.get().prWatch).toEqual({});
		expect(s.h.state.get().deps.lastRun[REPO]?.result).toBe("ready");
	});

	test("DMs that nothing changed when the run opens no PR", async () => {
		const s = setup();
		await s.tick();

		expect(s.dms()).toEqual([`No dependency upgrades for ${REPO}.`]);
		expect(s.h.state.get().deps.lastRun[REPO]?.result).toBe("no-changes");
	});

	test("ignores PRs from before the job or without the deps prefix", async () => {
		const s = setup({
			existing: [{ headRefName: "feature/other", url: "https://github.com/example-org/app/pull/1" }],
			script: (_run, open) => (open({ headRefName: "feature/new" }), OK_RESULT),
		});
		await s.tick();
		expect(s.dms()).toEqual([`No dependency upgrades for ${REPO}.`]);
	});

	test("DMs a failure with the job log path when the agent fails", async () => {
		const s = setup({ script: () => ({ ...OK_RESULT, status: 1 }) });
		await s.tick();

		expect(s.dms()).toHaveLength(1);
		expect(s.dms()[0]).toContain(`Deps upgrade failed for ${REPO}.`);
		expect(s.dms()[0]).toContain(replyText("CR-203", { agent: "claude" }));
		expect(s.dms()[0]).toContain(join(s.h.paths.jobsDir, "deps-github.com-example-org-app.log"));
		expect(s.h.state.get().deps.lastRun[REPO]?.result).toBe("failed");
	});

	test("skips the repo while a deps PR is still open", async () => {
		const s = setup({ existing: [{}] });
		await s.tick();

		expect(s.h.runner.runs).toEqual([]);
		expect(s.dms()).toEqual([]);
		expect(s.h.state.get().deps.lastRun[REPO]?.result).toBe("skipped");
		await s.tick();
		expect(s.h.runner.runs).toEqual([]);
	});

	test("runs once per window, even after a restart inside it", async () => {
		const s = setup();
		await s.tick();
		await s.tick();
		expect(s.h.runner.runs).toHaveLength(1);

		const restarted = createDepsFlow({
			state: s.h.state,
			config: s.h.config,
			notify: async () => {},
			repos: {
				defaultBranch: async () => "main",
				openPrs: async () => [],
				prStatus: async () => ({ state: "OPEN", isDraft: true, checks: [] }),
				markReady: async () => {},
			},
			runRepoJob: async () => ({ kind: "aborted" }),
			enqueue: () => true,
			jobsDir: s.h.paths.jobsDir,
			clock: s.h.clock,
			log: s.h.log,
		});
		await restarted.tick(new AbortController().signal);
		expect(s.h.runner.runs).toHaveLength(1);
	});

	test("runs again in the next window", async () => {
		const s = setup();
		await s.tick();
		s.h.clock.advance(24 * 3_600_000);
		await s.tick();
		expect(s.h.runner.runs).toHaveLength(2);
	});

	test("does nothing while deps are disabled", async () => {
		const s = setup({ deps: { enabled: false } });
		await s.tick();
		expect(s.h.runner.runs).toEqual([]);
		expect(s.h.state.get().deps.lastRun).toEqual({});
	});

	test("does nothing for a repo whose window is not due", async () => {
		const s = setup({ deps: { repos: [{ repo: REPO, schedule: { every: "week", day: "mon" } }] } });
		await s.tick();
		expect(s.h.runner.runs).toEqual([]);
	});

	test("recover marks an interrupted deps run failed and DMs it", async () => {
		const s = setup();
		s.h.state.recordDepsRun(REPO, { windowStart: "2026-10-14T00:00:00.000Z", result: "running" });
		s.h.state.recordDepsRun("github.com/example-org/lib", {
			windowStart: "2026-10-14T00:00:00.000Z",
			result: "ready",
		});

		await s.h.engine.recover({
			isAlive: () => false,
			listArgs: () => "",
			startTime: () => undefined,
			killTree: () => undefined,
		});

		expect(s.h.state.get().deps.lastRun[REPO]).toMatchObject({
			windowStart: "2026-10-14T00:00:00.000Z",
			result: "failed",
		});
		expect(s.h.state.get().deps.lastRun["github.com/example-org/lib"]?.result).toBe("ready");
		expect(s.dms()).toHaveLength(1);
		expect(s.dms()[0]).toContain(`Deps upgrade for ${REPO} was interrupted.`);
		expect(s.dms()[0]).toContain("CR-205");
	});
});
