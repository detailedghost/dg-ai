import { afterEach, describe, expect, test } from "bun:test";
import {
	OK_RESULT,
	abortable,
	createEngineHarness,
	deferred,
	reviewMessage,
	waitUntil,
} from "./support/fakes";
import type { EngineHarness, HarnessOptions, RunnerResult } from "./support/fakes";

const harnesses: EngineHarness[] = [];
function setup(options: HarnessOptions = {}): EngineHarness {
	const harness = createEngineHarness(options);
	harnesses.push(harness);
	return harness;
}
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const pr = (n: number): string => `https://github.com/o/r/pull/${n}`;

describe("engine while busy", () => {
	test("reacts pending on a new request for another PR while a review runs", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			runnerScript: (_run, index) => (index === 0 ? gate.promise : OK_RESULT),
		});
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await waitUntil(() => h.runner.runs.length === 1);
		await h.engine.handle(reviewMessage("m2", pr(2)));
		expect(h.trail("m2")).toEqual(["+pending"]);
		expect(h.trail("m1")).toEqual(["+pending", "-pending", "+inProgress"]);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.trail("m2")).toEqual([
			"+pending",
			"-pending",
			"+inProgress",
			"-inProgress",
			"+approved",
		]);
	});

	test("reacts pending on a new request while a repo job runs, then reviews it afterwards", async () => {
		const gate = deferred<void>();
		const h = setup();
		expect(
			h.engine.enqueueRepo({ id: "fix-1", url: pr(9), work: () => gate.promise }),
		).toBe(true);
		await h.engine.handle(reviewMessage("m1", pr(1)));
		expect(h.trail("m1")).toEqual(["+pending"]);
		expect(h.runner.runs).toHaveLength(0);
		gate.resolve();
		await h.engine.idle();
		expect(h.trail("m1")).toEqual([
			"+pending",
			"-pending",
			"+inProgress",
			"-inProgress",
			"+approved",
		]);
	});

	test("reacts pending on a new request while a stacked review is between PRs", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			descendants: { [pr(1)]: [{ number: 2, url: pr(2) }] },
			runnerScript: (_run, index) => (index === 1 ? gate.promise : OK_RESULT),
		});
		await h.engine.handle(reviewMessage("m1", pr(1), "~stacked"));
		await waitUntil(() => h.runner.runs.length === 2);
		await h.engine.handle(reviewMessage("m2", pr(5)));
		expect(h.trail("m2")).toEqual(["+pending"]);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(3);
	});

	test("handles a same-PR request for a different PR number key independently of a running job", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			runnerScript: (_run, index) => (index === 0 ? gate.promise : OK_RESULT),
		});
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", pr(2)));
		await h.engine.handle(reviewMessage("m3", pr(3)));
		expect(h.trail("m2")).toEqual(["+pending"]);
		expect(h.trail("m3")).toEqual(["+pending"]);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(3);
	});
});

describe("engine worker pool", () => {
	const twoWorkers: HarnessOptions["configExtra"] = { runner: { concurrency: 2 } };

	test("runs reviews for different PRs at the same time", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ configExtra: twoWorkers, runnerScript: () => gate.promise });
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", pr(2)));
		await waitUntil(() => h.runner.active === 2);
		expect(Object.keys(h.state.get().running).sort()).toEqual(["m1", "m2"]);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.maxActive).toBe(2);
		expect(h.state.get().running).toEqual({});
		expect(h.state.get().current).toBeNull();
	});

	test("holds a third job until a worker frees and reacts pending at once", async () => {
		const gates = [deferred<RunnerResult>(), deferred<RunnerResult>()];
		const h = setup({
			configExtra: twoWorkers,
			runnerScript: (_run, index) => (index < 2 ? gates[index].promise : OK_RESULT),
		});
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", pr(2)));
		await h.engine.handle(reviewMessage("m3", pr(3)));
		await waitUntil(() => h.runner.runs.length === 2);
		expect(h.trail("m3")).toEqual(["+pending"]);
		gates[1].resolve(OK_RESULT);
		await waitUntil(() => h.runner.runs.length === 3);
		await waitUntil(() => h.trail("m3").includes("+inProgress"));
		expect(h.trail("m1")).toEqual(["+pending", "-pending", "+inProgress"]);
		gates[0].resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.maxActive).toBe(2);
	});

	test("gives each running review its own working directory", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ configExtra: twoWorkers, runnerScript: () => gate.promise });
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", pr(2)));
		await waitUntil(() => h.runner.runs.length === 2);
		const [first, second] = h.runner.runs.map((run) => run.cwd);
		expect(first).not.toBe(second);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
	});

	test("never overlaps two requests for the same PR", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ configExtra: twoWorkers, runnerScript: () => gate.promise });
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", `${pr(1)}/files`));
		await waitUntil(() => h.runner.runs.length === 1);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(1);
		expect(h.runner.maxActive).toBe(1);
	});

	test("runs a repo job beside a review", async () => {
		const gate = deferred<RunnerResult>();
		const repoGate = deferred<void>();
		const h = setup({ configExtra: twoWorkers, runnerScript: () => gate.promise });
		h.engine.enqueueRepo({ id: "fix-1", url: pr(9), work: () => repoGate.promise });
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await waitUntil(() => h.runner.runs.length === 1);
		repoGate.resolve();
		gate.resolve(OK_RESULT);
		await h.engine.idle();
	});

	test("stop aborts every running job", async () => {
		const h = setup({
			configExtra: twoWorkers,
			runnerScript: (run) =>
				abortable(run, new Promise<RunnerResult>(() => undefined)),
		});
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", pr(2)));
		await waitUntil(() => h.runner.runs.length === 2);
		await h.engine.stop();
		expect(h.runner.runs.every((run) => run.signal.aborted)).toBe(true);
		expect(h.runner.active).toBe(0);
		expect(h.state.get().running).toEqual({});
	});

	test("refuses a request with CR-109 when the queue is full", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ runnerScript: () => gate.promise });
		for (let n = 1; n <= 64; n += 1) await h.engine.handle(reviewMessage(`m${n}`, pr(n)));
		await h.engine.handle(reviewMessage("m65", pr(65)));
		expect(h.trail("m65")).toEqual(["+failure"]);
		expect(h.replies().some((reply) => reply.text.startsWith("CR-109"))).toBe(true);
		expect(h.state.get().handled.m65?.status).toBe("failed");
		gate.resolve(OK_RESULT);
		await h.engine.idle();
	});

	test("recover kills every orphaned runner process and fails every interrupted request", async () => {
		const h = setup({ configExtra: twoWorkers });
		const startedAt = h.clock().toISOString();
		for (const [index, id] of ["m1", "m2"].entries()) {
			h.state.markHandled(id, "running");
			h.state.setRunning(id, {
				messageId: id,
				url: pr(index + 1),
				number: index + 1,
				startedAt,
				pid: 100 + index,
				pidStart: `s${100 + index}`,
			});
		}
		const killed: number[] = [];
		await h.engine.recover({
			isAlive: () => true,
			listArgs: () => "claude --print",
			startTime: (pid) => `s${pid}`,
			killTree: (pid) => {
				killed.push(pid);
			},
		});
		expect(killed.sort()).toEqual([100, 101]);
		expect(h.state.get().running).toEqual({});
		expect(h.state.get().current).toBeNull();
		expect(h.state.get().handled.m1?.status).toBe("failed");
		expect(h.state.get().handled.m2?.status).toBe("failed");
	});
});
