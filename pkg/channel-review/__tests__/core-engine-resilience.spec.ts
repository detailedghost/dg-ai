import { afterEach, describe, expect, test } from "bun:test";
import { ownerName, replyText } from "../src/errors";
import type { CrCode } from "../src/errors";
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
const crText = (h: EngineHarness, code: CrCode): string =>
	replyText(code, {
		agent: "claude",
		minutes: h.config.runner.timeoutMinutes,
		owner: ownerName(h.config.owner.token),
	});

describe("engine unexpected throws", () => {
	test("maps a runner that throws to CR-203 and logs the error", async () => {
		const h = setup({
			runnerScript: () => {
				throw new Error("spawn exploded");
			},
		});
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-203")]);
		expect(h.trail("m1").at(-1)).toBe("+failure");
		expect(h.log.lines.some((l) => l.level === "error")).toBe(true);
		expect(h.state.get().current).toBeNull();
	});

	test("maps a verdict reader that throws a plain error to CR-203 and logs it", async () => {
		const h = setup({
			verdictScript: () => {
				throw new Error("gh crashed");
			},
		});
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-203")]);
		expect(h.trail("m1").at(-1)).toBe("+failure");
		expect(h.log.lines.some((l) => l.level === "error")).toBe(true);
	});

	test("maps a stack reader that throws a plain error to CR-304 with no runs", async () => {
		const h = setup();
		h.stack.descendants = async () => {
			throw new Error("graph unreadable");
		};
		await h.engine.handle(reviewMessage("m1", pr(10), "~stacked"));
		await h.engine.idle();
		expect(h.runner.runs).toEqual([]);
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-304")]);
		expect(h.trail("m1").at(-1)).toBe("+failure");
	});

	test("frees the PR for a new review after a crashed run", async () => {
		const h = setup({
			runnerScript: (_run, index) => {
				if (index === 0) throw new Error("first run crashes");
				return OK_RESULT;
			},
		});
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		await h.engine.handle(reviewMessage("m2"));
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(2);
		expect(h.trail("m2").at(-1)).toBe("+approved");
	});
});

describe("engine stop during a stacked review", () => {
	test("aborts the stack, replies CR-205 once, and skips the remaining PRs", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			descendants: { [pr(10)]: [{ number: 11, url: pr(11) }] },
			runnerScript: (run) => abortable(run, gate.promise),
		});
		await h.engine.handle(reviewMessage("m1", pr(10), "~stacked"));
		await waitUntil(() => h.runner.runs.length === 1);
		await h.engine.stop();
		expect(h.runner.runs).toHaveLength(1);
		expect(h.trail("m1").at(-1)).toBe("+failure");
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-205")]);
		expect(h.state.get().handled.m1?.status).toBe("failed");
		expect(h.state.get().current).toBeNull();
	});
});

describe("engine stop before the runner starts", () => {
	function holdProbe(h: EngineHarness) {
		const gate = deferred<void>();
		const probe = h.runner.probe;
		let probing = false;
		h.runner.probe = async () => {
			probing = true;
			await gate.promise;
			return probe();
		};
		return { gate, isProbing: () => probing };
	}

	test("skips the run and replies CR-205 once when stop lands during the probe", async () => {
		const h = setup({ runnerScript: (run) => abortable(run, deferred<RunnerResult>().promise) });
		const { gate, isProbing } = holdProbe(h);
		await h.engine.handle(reviewMessage("m1"));
		await waitUntil(isProbing);
		const stopping = h.engine.stop();
		gate.resolve();
		await stopping;
		expect(h.runner.runs).toHaveLength(0);
		expect(h.trail("m1").at(-1)).toBe("+failure");
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-205")]);
		expect(h.state.get().handled.m1?.status).toBe("failed");
		expect(h.state.get().current).toBeNull();
	});

	test("skips the stacked run when stop lands between the probe and the stack read", async () => {
		const h = setup({ descendants: { [pr(10)]: [{ number: 11, url: pr(11) }] } });
		const gate = deferred<void>();
		const descendants = h.stack.descendants;
		h.stack.descendants = async (request) => {
			await gate.promise;
			return descendants(request);
		};
		await h.engine.handle(reviewMessage("m1", pr(10), "~stacked"));
		await waitUntil(() => h.runner.probeCalls === 1);
		const stopping = h.engine.stop();
		gate.resolve();
		await stopping;
		expect(h.runner.runs).toHaveLength(0);
		expect(h.trail("m1").at(-1)).toBe("+failure");
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-205")]);
		expect(h.state.get().handled.m1?.status).toBe("failed");
		expect(h.state.get().current).toBeNull();
	});
});
