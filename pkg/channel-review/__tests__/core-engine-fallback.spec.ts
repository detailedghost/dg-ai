import { afterEach, expect, test } from "bun:test";
import { basename } from "node:path";
import { replyText } from "../src/errors";
import {
	addressMessage,
	createEngineHarness,
	deferred,
	type EngineHarness,
	type HarnessOptions,
	OK_RESULT,
	PR_URL,
	reviewMessage,
	waitUntil,
} from "./support/fakes";

const LIMIT = { ...OK_RESULT, status: 1, code: "CR-207" } as const;
const harnesses: EngineHarness[] = [];
const setup = (options: HarnessOptions = {}) => {
	const h = createEngineHarness({
		runnerScript: () => LIMIT,
		configExtra: { runner: { fallback: "codex" } },
		...options,
	});
	harnesses.push(h);
	return h;
};
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

test("Claude exhaustion retries with Codex when it is the configured fallback and reads only its verdict", async () => {
	const h = setup();
	h.runners.codex.run = async (request) => {
		h.runners.codex.runs.push(request);
		expect(h.state.get().current?.execution).toEqual({ origin: "daemon", backend: "codex", model: undefined, modelSource: "default" });
		return OK_RESULT;
	};
	await h.engine.handle(
		reviewMessage("m1", PR_URL, "~spice 4 ~comment ~model Opus"),
	);
	await h.engine.idle();
	expect(h.runner.runs).toHaveLength(1);
	expect(h.runner.runs[0]?.model).toBe("Opus");
	expect(h.runners.codex.probeCalls).toBe(1);
	expect(h.runners.codex.runs).toHaveLength(1);
	expect(h.runners.codex.runs[0]).toMatchObject({
		task: "thrash",
		url: PR_URL,
		spice: 4,
		comment: true,
	});
	expect(h.runners.codex.runs[0]?.model).toBeUndefined();
	expect(basename(h.runners.codex.runs[0]!.logPath)).toBe(
		"m1-fallback-codex.log",
	);
	expect(h.verdict.reads).toHaveLength(1);
	expect(h.state.get().handled.m1?.status).toBe("done");
	expect(h.trail("m1").at(-1)).toBe("+approved");
	expect(h.provider.dms).toHaveLength(0);
	expect(h.replies()[0]).toMatchObject({ html: true });
	expect(h.replies()[0]?.text).toContain('itemid="m1"');
	expect(h.replies()[0]?.text).toContain(`<p>${PR_URL}</p>`);
	expect(h.replies()[0]?.text).not.toContain("$review");
	expect(h.replies()[0]?.text).toContain(
		"Claude is out of tokens, so I'm using Codex for this review.",
	);
});

test.each(["CR-201", "CR-202", "CR-206"] as const)(
	"does not run an unavailable fallback (%s)",
	async (code) => {
		const h = setup();
		h.runners.codex.probeResult = { ok: false, code };
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.runners.codex.runs).toHaveLength(0);
		expect(h.verdict.reads).toHaveLength(0);
		expect(h.replies().map((r) => r.text)).toEqual([
			replyText("CR-207", { agent: "claude" }),
		]);
		expect(h.provider.dms).toHaveLength(0);
	},
);

test("does not loop when Codex also hits its limit", async () => {
	const h = setup();
	await h.engine.handle(reviewMessage("m1"));
	await h.engine.idle();
	expect(h.runner.runs).toHaveLength(1);
	expect(h.runners.codex.runs).toHaveLength(1);
	expect(h.runners.copilot.runs).toHaveLength(0);
	expect(h.replies().at(-1)?.text).toBe(
		replyText("CR-207", { agent: "codex" }),
	);
	expect(h.provider.dms).toHaveLength(0);
	expect(h.state.get().handled.m1?.status).toBe("failed");
});

test("keeps Codex for remaining PRs in a stack", async () => {
	const child = "https://github.com/o/r/pull/13";
	const h = setup({ descendants: { [PR_URL]: [{ number: 13, url: child }] } });
	h.runners.codex.run = async (request) => {
		h.runners.codex.runs.push(request);
		return OK_RESULT;
	};
	await h.engine.handle(reviewMessage("m1", PR_URL, "~stacked"));
	await h.engine.idle();
	expect(h.runner.runs).toHaveLength(1);
	expect(
		h.runners.codex.runs.map((r) => (r.task === "thrash" ? r.url : "")),
	).toEqual([PR_URL, child]);
	expect(h.runners.codex.probeCalls).toBe(1);
	expect(h.verdict.reads).toHaveLength(2);
});

test("does not fall back when the fallback key is absent", async () => {
	const h = setup({ configExtra: {} });
	await h.engine.handle(reviewMessage("m1"));
	await h.engine.idle();
	expect(h.runners.codex.probeCalls).toBe(0);
	expect(h.runners.codex.runs).toHaveLength(0);
	expect(h.replies().at(-1)?.text).toBe(
		replyText("CR-207", { agent: "claude" }),
	);
});

test("can disable automatic fallback", async () => {
	const h = setup({ configExtra: { runner: { fallback: null } } });
	await h.engine.handle(reviewMessage("m1"));
	await h.engine.idle();
	expect(h.runners.codex.probeCalls).toBe(0);
	expect(h.replies().at(-1)?.text).toBe(
		replyText("CR-207", { agent: "claude" }),
	);
});

test.each(["CR-203", "CR-204", "CR-205"] as const)(
	"does not retry other review failures (%s)",
	async (code) => {
		const h = setup({
			runnerScript: () => ({
				...OK_RESULT,
				status: 1,
				timedOut: code === "CR-204",
				aborted: code === "CR-205",
			}),
		});
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.runners.codex.probeCalls).toBe(0);
		expect(h.provider.dms).toHaveLength(0);
		expect(h.replies().at(-1)?.text).toContain(code);
	},
);

test("stop during the fallback probe prevents a second run", async () => {
	const h = setup();
	const gate = deferred<void>();
	h.runners.codex.probe = async () => {
		h.runners.codex.probeCalls++;
		await gate.promise;
		return { ok: true };
	};
	await h.engine.handle(reviewMessage("m1"));
	await waitUntil(() => h.runners.codex.probeCalls === 1);
	const stopping = h.engine.stop();
	gate.resolve();
	await stopping;
	expect(h.runners.codex.runs).toHaveLength(0);
	expect(h.replies().at(-1)?.text).toContain("CR-205");
});

test("fallback shares the original review deadline and resets verdict freshness", async () => {
	const h = setup();
	h.runners.codex.probe = async () => {
		h.clock.advance(60_000);
		return { ok: true };
	};
	h.runners.codex.run = async (request) => {
		h.runners.codex.runs.push(request);
		return OK_RESULT;
	};
	await h.engine.handle(reviewMessage("m1"));
	await h.engine.idle();
	expect(h.runners.codex.runs[0]?.timeoutMs).toBe(
		h.config.runner.timeoutMinutes * 60_000 - 60_000,
	);
	expect(h.verdict.reads[0]?.since).toEqual(h.clock());
});

test("address limits notify the owner without retrying a write task", async () => {
	const h = setup();
	await h.engine.handle(addressMessage("m1"));
	await h.engine.idle();
	expect(h.runners.codex.probeCalls).toBe(0);
	expect(h.provider.dms[0]?.text).toContain("Task: address");
	expect(h.replies().at(-1)?.text).toContain("CR-207");
});

test("does not start a fallback when its probe exhausts the review deadline", async () => {
	const h = setup();
	h.runners.codex.probe = async () => {
		h.clock.advance(h.config.runner.timeoutMinutes * 60_000);
		return { ok: true };
	};
	await h.engine.handle(reviewMessage("m1"));
	await h.engine.idle();
	expect(h.runners.codex.runs).toHaveLength(0);
	expect(h.replies().at(-1)?.text).toContain("CR-204");
});

test("explicit Codex reviews do not switch back to Claude", async () => {
	const h = setup();
	await h.engine.handle(reviewMessage("m1", PR_URL, "~agent codex"));
	await h.engine.idle();
	expect(h.runner.runs).toHaveLength(0);
	expect(h.runners.codex.runs).toHaveLength(1);
	expect(h.provider.dms).toHaveLength(0);
	expect(h.replies().at(-1)?.text).toBe(
		replyText("CR-207", { agent: "codex" }),
	);
});

test("Grok is an explicitly configured fallback and uses its own model", async () => {
	const h = setup({ configExtra: { runner: { fallback: "grok" } } });
	h.runners.grok.run = async (request) => { h.runners.grok.runs.push(request); return OK_RESULT; };
	await h.engine.handle(reviewMessage("m1", PR_URL, "~model claude-model"));
	await h.engine.idle();
	expect(h.runners.codex.probeCalls).toBe(0);
	expect(h.runners.grok.probeCalls).toBe(1);
	expect(h.runners.grok.runs).toHaveLength(1);
	expect(h.runners.grok.runs[0]?.model).toBeUndefined();
	expect(basename(h.runners.grok.runs[0]!.logPath)).toBe("m1-fallback-grok.log");
	expect(h.replies()[0]?.text).toContain("using Grok for this review");
	expect(h.state.get().handled.m1?.status).toBe("done");
});

test("explicit Grok exhaustion does not retry with another runner", async () => {
	const h = setup();
	await h.engine.handle(reviewMessage("m1", PR_URL, "~agent grok ~model grok-4.6"));
	await h.engine.idle();
	expect(h.runners.grok.runs[0]?.model).toBe("grok-4.6");
	expect(h.runners.claude.runs).toHaveLength(0);
	expect(h.runners.codex.runs).toHaveLength(0);
	expect(h.replies().at(-1)?.text).toBe(replyText("CR-207", { agent: "grok" }));
});

test("ignores a usage-limit match on a clean exit when a verdict was posted", async () => {
	const h = setup({ runnerScript: () => ({ ...OK_RESULT, status: 0, code: "CR-207" }) });
	await h.engine.handle(reviewMessage("m1"));
	await h.engine.idle();
	expect(h.runners.codex.runs).toHaveLength(0);
	expect(h.state.get().handled.m1?.status).toBe("done");
	expect(h.trail("m1").at(-1)).toBe("+approved");
	expect(h.replies().map((r) => r.text)).not.toContain(replyText("CR-207", { agent: "claude" }));
});

test("keeps a clean-exit usage-limit match when no verdict was posted", async () => {
	const h = setup({
		runnerScript: () => ({ ...OK_RESULT, status: 0, code: "CR-207" }),
		verdictScript: () => "none",
		configExtra: { runner: { fallback: null } },
	});
	await h.engine.handle(reviewMessage("m1"));
	await h.engine.idle();
	expect(h.state.get().handled.m1?.status).toBe("failed");
	expect(h.replies().at(-1)?.text).toBe(replyText("CR-207", { agent: "claude" }));
});
