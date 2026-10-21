import { afterEach, describe, expect, test } from "bun:test";
import {
	OK_RESULT,
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
