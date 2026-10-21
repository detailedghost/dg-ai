import { afterEach, describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { ownerName, replyText } from "../src/errors";
import type { CrCode } from "../src/errors";
import { helpText } from "../src/help";
import { decorateReply, funVerdictFor } from "../src/fun";
import { VERDICT_LABELS, formatStackSummary } from "../src/summary";
import type { StackRow } from "../src/summary";
import { VerdictError } from "../src/verdict/types";
import type { Verdict } from "../src/verdict/types";
import {
	CHAT_ID,
	OK_RESULT,
	PR_URL,
	abortable,
	buildMessage,
	createEngineHarness,
	deferred,
	emojiEntry,
	gifEntry,
	reviewMessage,
	waitUntil,
} from "./support/fakes";
import type {
	EngineHarness,
	HarnessOptions,
	RunnerResult,
} from "./support/fakes";

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
const FAILED_RUN: RunnerResult = { ...OK_RESULT, status: 1 };
const FULL_TRAIL = [
	"+pending",
	"-pending",
	"+inProgress",
	"-inProgress",
];

const crText = (
	h: EngineHarness,
	code: CrCode,
	agent = "claude",
): string =>
	replyText(code, {
		agent,
		minutes: h.config.runner.timeoutMinutes,
		owner: ownerName(h.config.owner.token),
	});

const verdictsByUrl =
	(map: Record<string, Verdict>) =>
	(request: { url: string }): Verdict =>
		map[request.url] ?? "approved";

const NO_PROCESS = {
	isAlive: () => false,
	listArgs: () => "",
	startTime: () => undefined,
	killTree: () => {},
};

describe("engine single review", () => {
	test("reacts pending, inProgress, approved on the trigger message with no reply", async () => {
		const h = setup();
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual([...FULL_TRAIL, "+approved"]);
		expect(h.replies()).toEqual([]);
		expect(h.runner.runs).toHaveLength(1);
		expect(h.state.get().handled.m1?.status).toBe("done");
		expect(h.state.get().current).toBeNull();
	});

	test("stamps handled entries with the injected clock", async () => {
		const h = setup();
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.state.get().handled.m1?.at).toBe(h.clock().toISOString());
	});

	test("marks a changes_requested run handled done", async () => {
		const h = setup({ verdictScript: () => "changes_requested" });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.state.get().handled.m1?.status).toBe("done");
		expect(h.state.get().current).toBeNull();
	});

	test("clears state.current after a failed run", async () => {
		const h = setup({ runnerScript: () => FAILED_RUN });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.state.get().current).toBeNull();
	});

	test("logs and marks done a second trigger for a PR already in flight", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ runnerScript: () => gate.promise });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.handle(reviewMessage("m2", `${PR_URL}/files`));
		await waitUntil(() => h.runner.runs.length === 1);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(1);
		expect(h.trail("m2")).toEqual([]);
		expect(h.state.get().handled.m2?.status).toBe("done");
		expect(h.log.lines.some((l) => l.level !== "error")).toBe(true);
	});

	test("reacts on the configured chat", async () => {
		const h = setup();
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.provider.calls.every((c) => c.chatId === CHAT_ID)).toBe(true);
	});

	test("ends changes_requested with the changesRequested reaction and no reply", async () => {
		const h = setup({ verdictScript: () => "changes_requested" });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual([...FULL_TRAIL, "+changesRequested"]);
		expect(h.replies()).toEqual([]);
	});

	test("ends commented with the comment reaction", async () => {
		const h = setup({ verdictScript: () => "commented" });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual([...FULL_TRAIL, "+comment"]);
	});

	test("passes url, spice, comment and the configured timeout to the runner", async () => {
		const h = setup();
		await h.engine.handle(reviewMessage("m1", PR_URL, "~spice 4 ~comment"));
		await h.engine.idle();
		expect(h.runner.runs[0]).toMatchObject({
			url: PR_URL,
			spice: 4,
			comment: true,
			timeoutMs: h.config.runner.timeoutMinutes * 60_000,
		});
		expect(h.runner.runs[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	test.each(["codex", "grok"] as const)("uses the runner named by ~agent %s", async (name) => {
		const h = setup();
		await h.engine.handle(reviewMessage("m1", PR_URL, `~agent ${name}`));
		await h.engine.idle();
		expect(h.runners[name].runs).toHaveLength(1);
		expect(h.runners.claude.runs).toHaveLength(0);
	});

	test("uses runner.default when no ~agent is given", async () => {
		const h = setup({ configExtra: { runner: { default: "copilot" } } });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.runners.copilot.runs).toHaveLength(1);
	});

	test("reads the verdict for the PR host since the run started", async () => {
		const h = setup();
		const started = h.clock();
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.verdict.reads).toHaveLength(1);
		expect(h.verdict.reads[0]).toMatchObject({ url: PR_URL, host: "github" });
		expect(h.verdict.reads[0]?.since.getTime()).toBe(started.getTime());
	});

	test("names the job log after the message id", async () => {
		const h = setup();
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(basename(h.runner.runs[0]?.logPath ?? "")).toBe("m1.log");
	});

	test("persists the configured Grok model while a daemon review is live", async () => {
		let snapshot: unknown;
		const h = setup({
			configExtra: { runner: { default: "grok", grok: { model: "configured-model" } } },
			runnerScript: () => {
				snapshot = h.state.get().current;
				return OK_RESULT;
			},
		});
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(snapshot).toMatchObject({ execution: { origin: "daemon", backend: "grok", model: "configured-model", modelSource: "configured" } });
		expect(h.log.lines.some(line => line.message.includes("configured-model"))).toBe(true);
	});

	test("records the spawned pid and the job in state.current while the run is live", async () => {
		let snapshot: unknown;
		const h = setup({
			runnerScript: (run) => {
				run.onSpawn?.(4242);
				snapshot = h.state.get().current;
				return OK_RESULT;
			},
		});
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(snapshot).toMatchObject({
			messageId: "m1",
			url: PR_URL,
			number: 12,
			pid: 4242,
			pidStart: "start-4242",
			execution: { origin: "daemon", backend: "claude", modelSource: "default" },
		});
		expect(typeof (snapshot as { startedAt: string }).startedAt).toBe("string");
	});

	test("ignores a message from a bot", async () => {
		const h = setup();
		await h.engine.handle(
			buildMessage("m1", "!owner $review " + PR_URL, {
				from: { isBot: true },
			}),
		);
		await h.engine.idle();
		expect(h.provider.calls).toEqual([]);
		expect(h.runner.runs).toEqual([]);
	});

	test("ignores a message without the owner token", async () => {
		const h = setup();
		await h.engine.handle(buildMessage("m1", `just chatting ${PR_URL}`));
		await h.engine.idle();
		expect(h.provider.calls).toEqual([]);
		expect(h.runner.runs).toEqual([]);
	});

	test("skips a message whose id is already handled", async () => {
		const h = setup();
		h.state.markHandled("m1", "done");
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.provider.calls).toEqual([]);
		expect(h.runner.runs).toEqual([]);
	});
});

describe("engine help", () => {
	test.each([
		["$help alone", "!owner $help", "overview"],
		["$help with $review", "!owner $review $help", "review"],
		["$help with $address", "!owner $help $address", "address"],
		["$help with a link", `!owner $help ${PR_URL}`, "overview"],
	] as const)("replies with the usage text and runs nothing for %s", async (_name, text, topic) => {
		const h = setup();
		await h.engine.handle(buildMessage("m1", text));
		await h.engine.idle();
		expect(h.runner.runs).toEqual([]);
		expect(h.trail("m1")).toEqual([]);
		expect(h.replies().map((r) => r.text)).toEqual([
			helpText("Review Bot", "!owner", h.config.rereview.phrases, h.config.reactions, { topic }),
		]);
		expect(h.replies()[0]?.html).toBe(true);
		expect(h.state.get().handled.m1?.status).toBe("done");
	});

	test("resolves the configured default model into the help text", async () => {
		const h = setup({
			configExtra: {
				runner: {
					claude: { bedrock: { model: "arn:aws:bedrock:us-east-2:1:application-inference-profile/abc", region: "us-east-2" } },
				},
			},
		});
		await h.engine.handle(buildMessage("m1", "!owner $help"));
		await h.engine.idle();
		expect(h.replies().map((r) => r.text)).toEqual([
			helpText("Review Bot", "!owner", h.config.rereview.phrases, h.config.reactions, {
				topic: "overview",
				allowAnySender: h.config.address.allowAnySender,
				defaultModel: "arn:aws:bedrock:us-east-2:1:application-inference-profile/abc",
			}),
		]);
	});

	test("ignores $help without the owner token", async () => {
		const h = setup();
		await h.engine.handle(buildMessage("m1", "$help"));
		await h.engine.idle();
		expect(h.provider.calls).toEqual([]);
	});
});

describe("engine queueing", () => {
	test("handle resolves before the queued run completes", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ runnerScript: () => gate.promise });
		await h.engine.handle(reviewMessage("m1"));
		expect(h.trail("m1")).not.toContain("+approved");
		expect(h.state.get().handled.m1?.status).not.toBe("done");
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.trail("m1")).toContain("+approved");
	});

	test("runs two messages one after the other, never concurrently", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			runnerScript: (_run, index) =>
				index === 0 ? gate.promise : Promise.resolve(OK_RESULT),
		});
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", pr(2)));
		await waitUntil(() => h.runner.runs.length >= 1);
		expect(h.runner.runs).toHaveLength(1);
		expect(h.trail("m2")).toEqual(["+pending"]);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs.map((r) => (r.task === "thrash" ? r.url : undefined))).toEqual([pr(1), pr(2)]);
		expect(h.runner.maxActive).toBe(1);
		expect(h.trail("m2")).toEqual([...FULL_TRAIL, "+approved"]);
	});

	test("idle resolves only after the last queued run", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ runnerScript: () => gate.promise });
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", pr(2)));
		let idle = false;
		void h.engine.idle().then(() => {
			idle = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(idle).toBe(false);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(2);
		expect(h.state.get().handled.m2?.status).toBe("done");
	});
});

describe("engine error mapping", () => {
	test("maps a timed-out run to the failure reaction on the trigger and a CR-204 reply without a reaction", async () => {
		const h = setup({ runnerScript: () => ({ ...OK_RESULT, status: null, timedOut: true }) });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual([...FULL_TRAIL, "+failure"]);
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-204")]);
		expect(h.trail("sent-1")).toEqual([]);
		expect(h.state.get().handled.m1?.status).toBe("failed");
	});

	test("maps a non-zero exit to CR-203 naming the agent", async () => {
		const h = setup({ runnerScript: () => FAILED_RUN });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~agent codex"));
		await h.engine.idle();
		expect(h.replies().map((r) => r.text)).toEqual([
			crText(h, "CR-203", "codex"),
		]);
		expect(h.trail("m1").at(-1)).toBe("+failure");
	});

	test.each(["CR-201", "CR-202"] as const)(
		"maps a result code %s to its reply",
		async (code) => {
			const h = setup({ runnerScript: () => ({ ...OK_RESULT, status: null, code }) });
			await h.engine.handle(reviewMessage("m1"));
			await h.engine.idle();
			expect(h.replies().map((r) => r.text)).toEqual([crText(h, code)]);
			expect(h.trail("m1").at(-1)).toBe("+failure");
		},
	);

	test("maps a verdict of none to CR-301", async () => {
		const h = setup({ verdictScript: () => "none" });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual([...FULL_TRAIL, "+failure"]);
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-301")]);
	});

	test("maps a VerdictError thrown by the verdict reader to its code", async () => {
		const h = setup({
			verdictScript: () => {
				throw new VerdictError("CR-302");
			},
		});
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-302")]);
		expect(h.trail("m1").at(-1)).toBe("+failure");
	});

	test.each(["CR-201", "CR-202", "CR-206"] as const)(
		"fails on a runner probe %s without invoking run",
		async (code) => {
			const h = setup();
			h.runner.probeResult = { ok: false, code };
			await h.engine.handle(reviewMessage("m1"));
			await h.engine.idle();
			expect(h.runner.runs).toEqual([]);
			expect(h.replies().map((r) => r.text)).toEqual([crText(h, code)]);
			expect(h.trail("m1").at(-1)).toBe("+failure");
		},
	);

	test("fails with CR-303 and no run when the verdict CLI probe fails", async () => {
		const h = setup();
		h.verdict.probeResult = { ok: false, code: "CR-303" };
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.runner.runs).toEqual([]);
		expect(h.verdict.probedHosts).toEqual(["github"]);
		expect(h.verdict.probes[0]?.url).toStartWith("https://github.com/");
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-303")]);
		expect(h.trail("m1").at(-1)).toBe("+failure");
	});

	test.each([
		["no PR link", "!owner $review", "CR-101"],
		["a ~spice of 7", `!owner $review ${PR_URL} ~spice 7`, "CR-102"],
		["an unknown agent", `!owner $review ${PR_URL} ~agent gemini`, "CR-103"],
	] as const)("replies %s with the catalog sentence and the failure reaction", async (_name, text, code) => {
		const h = setup();
		await h.engine.handle(buildMessage("m1", text));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual(["+failure"]);
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, code)]);
		expect(h.runner.runs).toEqual([]);
	});

	test("marks a parse-error message failed before the reaction is sent", async () => {
		const h = setup();
		const seen: (string | undefined)[] = [];
		h.provider.onCall = () => {
			seen.push(h.state.get().handled.m1?.status);
		};
		await h.engine.handle(buildMessage("m1", "!owner $review"));
		await h.engine.idle();
		expect(seen[0]).toBe("failed");
	});

	test("produces no second reply for a replayed parse-error message", async () => {
		const h = setup();
		const message = buildMessage("m1", "!owner $review");
		await h.engine.handle(message);
		await h.engine.handle(message);
		await h.engine.idle();
		expect(h.replies()).toHaveLength(1);
		expect(h.trail("m1")).toEqual(["+failure"]);
	});

	test("logs a failing reply and still marks the entry failed", async () => {
		const h = setup({ runnerScript: () => FAILED_RUN });
		h.provider.failReplies = true;
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.state.get().handled.m1?.status).toBe("failed");
		expect(h.log.lines.some((l) => l.level !== "info")).toBe(true);
	});

	test("logs a failing reaction and never throws", async () => {
		const h = setup();
		h.provider.failReactions = true;
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.log.lines.some((l) => l.level !== "info")).toBe(true);
	});
});

describe("engine multiple chats", () => {
	const OTHER_CHAT = "chat-2";
	const inChat = (h: EngineHarness, chatId: string) =>
		h.provider.calls.filter((call) => call.chatId === chatId);

	test("reacts and replies in the chat of each message", async () => {
		const h = setup({ funPool: [gifEntry("approved")] });
		await h.engine.handle(reviewMessage("m1", pr(1), "~fun"));
		await h.engine.handle(
			buildMessage("m2", reviewMessage("m2", pr(2), "~fun").text, {
				chatId: OTHER_CHAT,
			}),
		);
		await h.engine.idle();
		expect(inChat(h, CHAT_ID).some((call) => call.op === "reply")).toBe(true);
		expect(inChat(h, OTHER_CHAT).some((call) => call.op === "reply")).toBe(true);
		expect(
			inChat(h, OTHER_CHAT).flatMap((call) =>
				call.op === "reply" ? [] : [call.messageId],
			),
		).not.toContain("m1");
		expect(h.provider.calls.length).toBe(
			inChat(h, CHAT_ID).length + inChat(h, OTHER_CHAT).length,
		);
		expect(h.state.get().handled.m2?.chatId).toBe(OTHER_CHAT);
	});

	test("runs jobs from both chats in one serial queue", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			runnerScript: (_run, index) =>
				index === 0 ? gate.promise : Promise.resolve(OK_RESULT),
		});
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(
			buildMessage("m2", reviewMessage("m2", pr(2)).text, { chatId: OTHER_CHAT }),
		);
		await waitUntil(() => h.runner.runs.length === 1);
		expect(h.trail("m2")).toEqual(["+pending"]);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs.map((r) => (r.task === "thrash" ? r.url : undefined))).toEqual([pr(1), pr(2)]);
		expect(h.runner.maxActive).toBe(1);
	});

	test("ignores a PR already in flight from another chat", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ runnerScript: () => gate.promise });
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(
			buildMessage("m2", reviewMessage("m2", pr(1)).text, { chatId: OTHER_CHAT }),
		);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(1);
		expect(inChat(h, OTHER_CHAT)).toEqual([]);
	});

	test("replies to a help request in the chat it came from", async () => {
		const h = setup();
		await h.engine.handle(buildMessage("m1", "!owner $help", { chatId: OTHER_CHAT }));
		expect(inChat(h, OTHER_CHAT)).toHaveLength(1);
		expect(inChat(h, CHAT_ID)).toEqual([]);
	});

	test("recover replies to the chat stored with each interrupted message", async () => {
		const h = setup();
		h.state.markHandled("m1", "pending", OTHER_CHAT);
		h.state.markHandled("m2", "running", CHAT_ID);
		h.state.markHandled("m3", "pending");
		await h.engine.recover(NO_PROCESS);
		const replyChats = h.provider.calls.flatMap((call) =>
			call.op === "reply" ? [call.chatId] : [],
		);
		expect(replyChats).toEqual([OTHER_CHAT, CHAT_ID, CHAT_ID]);
		expect(
			h.provider.calls.find(
				(call) => call.op !== "reply" && call.messageId === "m1",
			)?.chatId,
		).toBe(OTHER_CHAT);
	});

	test("stores the chat on current and blocked entries", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			runnerScript: () => gate.promise,
			verdictScript: () => "changes_requested",
		});
		await h.engine.handle(
			buildMessage("m1", reviewMessage("m1").text, { chatId: OTHER_CHAT }),
		);
		await waitUntil(() => h.state.get().current !== null);
		expect(h.state.get().current?.chatId).toBe(OTHER_CHAT);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.state.get().blocked[PR_URL]?.chatId).toBe(OTHER_CHAT);
	});

	test("answers a readiness message in the chat it came from", async () => {
		const h = setup({ verdictScript: () => "approved" });
		h.state.markBlocked(PR_URL, "m0", { comment: false, fun: false }, CHAT_ID);
		await h.engine.handle(
			buildMessage("m2", `ptal ${PR_URL}`, { chatId: OTHER_CHAT }),
		);
		await h.engine.idle();
		expect(inChat(h, OTHER_CHAT).length).toBeGreaterThan(0);
		expect(inChat(h, CHAT_ID)).toEqual([]);
	});
});

describe("engine stop and recover", () => {
	test("stop aborts the running job, reacts failure, replies CR-205 and leaves a queued entry pending", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ runnerScript: (run) => abortable(run, gate.promise) });
		await h.engine.handle(reviewMessage("m1", pr(1)));
		await h.engine.handle(reviewMessage("m2", pr(2)));
		await waitUntil(() => h.runner.runs.length === 1);
		await h.engine.stop();
		await h.engine.idle();
		expect(h.runner.runs[0]?.signal.aborted).toBe(true);
		expect(h.trail("m1").at(-1)).toBe("+failure");
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-205")]);
		expect(h.state.get().handled.m1?.status).toBe("failed");
		expect(h.state.get().current).toBeNull();
		expect(h.state.get().handled.m2?.status).toBe("pending");
		expect(h.trail("m2")).toEqual(["+pending"]);
		expect(h.runner.runs).toHaveLength(1);
	});

	test.each(["pending", "running"] as const)(
		"recover turns a %s entry into the failure reaction and a CR-205 reply",
		async (status) => {
			const h = setup();
			h.state.markHandled("m1", status);
			await h.engine.recover(NO_PROCESS);
			expect(h.trail("m1")).toContain("+failure");
			expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-205")]);
			expect(h.state.get().handled.m1?.status).toBe("failed");
		},
	);

	test("recover leaves done and failed entries alone", async () => {
		const h = setup();
		h.state.markHandled("m1", "done");
		h.state.markHandled("m2", "failed");
		await h.engine.recover(NO_PROCESS);
		expect(h.provider.calls).toEqual([]);
	});

	const staleCurrent = (h: EngineHarness, ageMinutes: number) => {
		h.state.markHandled("m1", "running");
		h.state.setCurrent({
			messageId: "m1",
			url: PR_URL,
			number: 12,
			startedAt: new Date(h.clock().getTime() - ageMinutes * 60_000).toISOString(),
			pid: 4242,
			pidStart: "start-4242",
		});
	};

	test("recover skips killTree and resets current when the job crashed before spawn", async () => {
		const h = setup();
		h.state.markHandled("m1", "running");
		h.state.setCurrent({
			messageId: "m1",
			url: PR_URL,
			number: 12,
			startedAt: h.clock().toISOString(),
		});
		const killed: number[] = [];
		await h.engine.recover({
			isAlive: () => true,
			listArgs: () => "bun channel-review claude -p /thrash",
			startTime: () => "start-4242",
			killTree: (pid: number) => {
				killed.push(pid);
			},
		});
		expect(killed).toEqual([]);
		expect(h.state.get().current).toBeNull();
		expect(h.state.get().handled.m1?.status).toBe("failed");
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-205")]);
	});

	test("recover kills the live runner tree whose startedAt is 5 minutes old", async () => {
		const h = setup();
		staleCurrent(h, 5);
		const killed: number[] = [];
		await h.engine.recover({
			isAlive: () => true,
			listArgs: () => "bun channel-review claude -p /thrash",
			startTime: () => "start-4242",
			killTree: (pid: number) => {
				killed.push(pid);
			},
		});
		expect(killed).toEqual([4242]);
	});

	test("recover skips a tree older than the longest job timeout", async () => {
		const h = setup();
		staleCurrent(h, 91);
		const killed: number[] = [];
		await h.engine.recover({
			isAlive: () => true,
			listArgs: () => "bun channel-review claude -p /thrash",
			startTime: () => "start-4242",
			killTree: (pid: number) => {
				killed.push(pid);
			},
		});
		expect(killed).toEqual([]);
	});

	test("recover skips a live runner whose start time differs from the recorded one", async () => {
		const h = setup();
		staleCurrent(h, 5);
		const killed: number[] = [];
		await h.engine.recover({
			isAlive: () => true,
			listArgs: () => "claude --interactive",
			startTime: () => "start-9999",
			killTree: (pid: number) => {
				killed.push(pid);
			},
		});
		expect(killed).toEqual([]);
		expect(h.state.get().current).toBeNull();
	});

	test("recover skips a pid recorded without a start time", async () => {
		const h = setup();
		h.state.markHandled("m1", "running");
		h.state.setCurrent({
			messageId: "m1",
			url: PR_URL,
			number: 12,
			startedAt: new Date(h.clock().getTime() - 5 * 60_000).toISOString(),
			pid: 4242,
		});
		const killed: number[] = [];
		await h.engine.recover({
			isAlive: () => true,
			listArgs: () => "claude",
			startTime: () => "start-4242",
			killTree: (pid: number) => {
				killed.push(pid);
			},
		});
		expect(killed).toEqual([]);
	});

	test("recover prunes handled entries older than a day", async () => {
		const h = setup();
		h.state.markHandled("old", "done");
		h.clock.advance(25 * 3_600_000);
		h.state.markHandled("fresh", "done");
		await h.engine.recover(NO_PROCESS);
		expect(Object.keys(h.state.get().handled)).toEqual(["fresh"]);
	});

	test("recover skips a dead pid", async () => {
		const h = setup();
		staleCurrent(h, 5);
		const killed: number[] = [];
		await h.engine.recover({
			isAlive: () => false,
			listArgs: () => "claude",
			startTime: () => "start-4242",
			killTree: (pid: number) => {
				killed.push(pid);
			},
		});
		expect(killed).toEqual([]);
	});

	test("recover skips a live pid whose command line is not a runner process", async () => {
		const h = setup();
		staleCurrent(h, 5);
		const killed: number[] = [];
		await h.engine.recover({
			isAlive: () => true,
			listArgs: () => "vim notes.txt",
			startTime: () => "start-4242",
			killTree: (pid: number) => {
				killed.push(pid);
			},
		});
		expect(killed).toEqual([]);
	});
});

describe("engine stacked review", () => {
	const tokens = "~stacked";
	const descendants = { [pr(10)]: [{ number: 11, url: pr(11) }, { number: 12, url: pr(12) }] };

	test("reviews the target then each descendant in stack order and posts one summary", async () => {
		const h = setup({
			descendants,
			runnerScript: (run) => (run.task === "thrash" && run.url === pr(11) ? FAILED_RUN : OK_RESULT),
			verdictScript: verdictsByUrl({
				[pr(10)]: "approved",
				[pr(12)]: "changes_requested",
			}),
		});
		await h.engine.handle(reviewMessage("m1", pr(10), tokens));
		await h.engine.idle();
		expect(h.runner.runs.map((r) => (r.task === "thrash" ? r.url : undefined))).toEqual([pr(10), pr(11), pr(12)]);
		const rows: StackRow[] = [
			{ number: 10, url: pr(10), outcome: "approved" },
			{ number: 11, url: pr(11), outcome: { code: "CR-203" } },
			{ number: 12, url: pr(12), outcome: "changes_requested" },
		];
		expect(h.replies().map((r) => r.text)).toEqual([formatStackSummary(rows)]);
		expect(h.trail("m1").at(-1)).toBe("+failure");
	});

	test("ends with the changesRequested reaction on the trigger only and summary lines when the runs end approved, changes_requested, approved", async () => {
		const h = setup({
			descendants,
			verdictScript: verdictsByUrl({ [pr(11)]: "changes_requested" }),
		});
		await h.engine.handle(reviewMessage("m1", pr(10), tokens));
		await h.engine.idle();
		const reply = h.replies()[0]?.text ?? "";
		expect(h.replies()).toHaveLength(1);
		expect(h.trail("m1").at(-1)).toBe("+changesRequested");
		expect(h.trail("sent-1")).toEqual([]);
		const lines = reply.split("\n").slice(1);
		expect(lines).toEqual([
			`${VERDICT_LABELS.approved.emoji} #10 ${pr(10)}`,
			`${VERDICT_LABELS.changes_requested.emoji} #11 ${pr(11)}`,
			`${VERDICT_LABELS.approved.emoji} #12 ${pr(12)}`,
		]);
	});

	test("gives each row its own verdict read and its own job log", async () => {
		const h = setup({ descendants });
		await h.engine.handle(reviewMessage("m1", pr(10), tokens));
		await h.engine.idle();
		expect(h.verdict.reads.map((r) => r.url)).toEqual([pr(10), pr(11), pr(12)]);
		expect(h.runner.runs.map((r) => basename(r.logPath))).toEqual([
			"m1-10.log",
			"m1-11.log",
			"m1-12.log",
		]);
		expect(new Set(h.runner.runs.map((r) => r.timeoutMs)).size).toBe(1);
	});

	test("posts no per-PR error replies", async () => {
		const h = setup({ descendants, runnerScript: () => FAILED_RUN });
		await h.engine.handle(reviewMessage("m1", pr(10), tokens));
		await h.engine.idle();
		expect(h.replies()).toHaveLength(1);
		expect(h.replies()[0]?.text).toStartWith("Stacked review:");
	});

	test("fails the whole job with CR-304 and zero runs when the stack cannot be read", async () => {
		const h = setup({ descendants });
		h.stack.failWith = "CR-304";
		await h.engine.handle(reviewMessage("m1", pr(10), tokens));
		await h.engine.idle();
		expect(h.runner.runs).toEqual([]);
		expect(h.trail("m1").at(-1)).toBe("+failure");
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-304")]);
	});

	test("reviews the target alone and still posts a summary when there are no descendants", async () => {
		const h = setup();
		await h.engine.handle(reviewMessage("m1", pr(10), tokens));
		await h.engine.idle();
		expect(h.runner.runs.map((r) => (r.task === "thrash" ? r.url : undefined))).toEqual([pr(10)]);
		expect(h.replies()).toHaveLength(1);
		expect(h.replies()[0]?.text).toStartWith("Stacked review:");
		expect(h.replies()[0]?.text).toContain(pr(10));
	});

	test("fails the whole job with one CR reply and no summary when the runner probe fails", async () => {
		const h = setup({ descendants });
		h.runner.probeResult = { ok: false, code: "CR-201" };
		await h.engine.handle(reviewMessage("m1", pr(10), tokens));
		await h.engine.idle();
		expect(h.runner.runs).toEqual([]);
		expect(h.replies().map((r) => r.text)).toEqual([crText(h, "CR-201")]);
	});

	test("records state.current with the PR url being reviewed", async () => {
		const seen: (string | undefined)[] = [];
		const h = setup({
			descendants,
			runnerScript: () => {
				seen.push(h.state.get().current?.url);
				return OK_RESULT;
			},
		});
		await h.engine.handle(reviewMessage("m1", pr(10), tokens));
		await h.engine.idle();
		expect(seen).toEqual([pr(10), pr(11), pr(12)]);
		expect(h.state.get().current).toBeNull();
	});

	test("registers the changes_requested PR of a stack as blocked under the trigger message", async () => {
		const h = setup({
			descendants,
			verdictScript: verdictsByUrl({ [pr(11)]: "changes_requested" }),
		});
		await h.engine.handle(reviewMessage("m1", pr(10), `${tokens} ~spice 2`));
		await h.engine.idle();
		expect(Object.keys(h.state.get().blocked)).toEqual([pr(11)]);
		expect(h.state.get().blocked[pr(11)]).toMatchObject({
			messageId: "m1",
			verdict: "changes_requested",
			options: { spice: 2 },
		});
	});
});

describe("engine re-review", () => {
	test("marks a changes_requested PR blocked with the original options", async () => {
		const h = setup({ verdictScript: () => "changes_requested" });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~spice 4 ~comment"));
		await h.engine.idle();
		expect(h.state.get().blocked[PR_URL]).toMatchObject({
			url: PR_URL,
			messageId: "m1",
			verdict: "changes_requested",
			options: { spice: 4, comment: true, fun: false },
		});
	});

	const blockThenFix = async (
		h: EngineHarness,
		fixedText = `fixed, ${PR_URL}`,
	) => {
		await h.engine.handle(reviewMessage("m1", PR_URL, "~spice 4 ~comment"));
		await h.engine.idle();
		await h.engine.handle(
			buildMessage("m2", fixedText, { from: { id: "u-2", name: "Sam", isBot: false } }),
		);
		await h.engine.idle();
	};

	test("re-reviews on a quoted reply to the blocked message that carries no link and reacts on the reply", async () => {
		let reads = 0;
		const h = setup({
			verdictScript: () => (reads++ === 0 ? "changes_requested" : "approved"),
		});
		const quoted = `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="m1"><strong itemprop="mri" itemid="8:orgid:abc">Dana</strong><p itemprop="copy">$review ${PR_URL}</p></blockquote><p><at id="0">Review Bot</at> ready</p>`;
		await blockThenFix(h, quoted);
		expect(h.runner.runs).toHaveLength(2);
		expect(h.runner.runs[1]).toMatchObject({ url: PR_URL, spice: 4, comment: true });
		expect(h.trail("m2")).toEqual([...FULL_TRAIL, "+approved"]);
		expect(h.state.get().blocked).toEqual({});
	});

	test("runs a second message 'fixed, <url>' with the first run's options and clears the registry on approval", async () => {
		let reads = 0;
		const h = setup({
			verdictScript: () => (reads++ === 0 ? "changes_requested" : "approved"),
		});
		await blockThenFix(h);
		expect(h.runner.runs).toHaveLength(2);
		expect(h.runner.runs[1]).toMatchObject({ url: PR_URL, spice: 4, comment: true });
		expect(h.trail("m2")).toEqual([...FULL_TRAIL, "+approved"]);
		expect(h.trail("m1")).toEqual([...FULL_TRAIL, "+changesRequested"]);
		expect(h.state.get().blocked).toEqual({});
	});

	test("keeps the PR blocked when the re-review ends changes_requested again", async () => {
		const h = setup({ verdictScript: () => "changes_requested" });
		await blockThenFix(h);
		expect(h.state.get().blocked[PR_URL]).toMatchObject({ messageId: "m2" });
		expect(h.trail("m2").at(-1)).toBe("+changesRequested");
	});

	test("clears the registry when the PR is gone (CR-302)", async () => {
		let reads = 0;
		const h = setup({
			verdictScript: () => {
				if (reads++ === 0) return "changes_requested";
				throw new VerdictError("CR-302");
			},
		});
		await blockThenFix(h);
		expect(h.state.get().blocked).toEqual({});
		expect(h.trail("m2").at(-1)).toBe("+failure");
	});

	test("matches a readiness message that links the /files view of the blocked PR", async () => {
		const h = setup({ verdictScript: () => "approved" });
		h.state.markBlocked(PR_URL, "m1", { spice: 3, comment: false, fun: false }, CHAT_ID);
		await h.engine.handle(buildMessage("m2", `ptal ${PR_URL}/files`));
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(1);
		expect(h.runner.runs[0]).toMatchObject({ url: PR_URL, spice: 3 });
	});

	test("re-runs a readiness message for a PR with no registry entry using default options", async () => {
		const h = setup();
		await h.engine.handle(buildMessage("m2", `fixed, ${PR_URL}`));
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(1);
		expect(h.runner.runs[0]).toMatchObject({ url: PR_URL, origin: "daemon" });
		expect(h.runner.runs[0]).not.toHaveProperty("spice", expect.anything());
		expect(h.trail("m2")).toEqual([...FULL_TRAIL, "+approved"]);
	});

	test("re-runs a ready reply on an approved PR with the options of the quoted request", async () => {
		const h = setup({ verdictScript: () => "approved" });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~spice 4 ~comment"));
		await h.engine.idle();
		const quoted = `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="m1"><strong itemprop="mri" itemid="8:orgid:abc">Dana</strong><p itemprop="copy">${h.config.owner.token} $review ${PR_URL} ~spice 4 ~comment</p></blockquote><p><at id="0">Review Bot</at> ready</p>`;
		await h.engine.handle(buildMessage("m2", quoted));
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(2);
		expect(h.runner.runs[1]).toMatchObject({ url: PR_URL, spice: 4, comment: true });
	});

	test("uses the stored options for a blocked PR when the quote carries a link", async () => {
		const h = setup({ verdictScript: () => "approved" });
		h.state.markBlocked(PR_URL, "m1", { spice: 2, comment: false, fun: false }, CHAT_ID);
		const quoted = `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="m0"><p itemprop="copy">Addressed #12 ${PR_URL}. Ready for re-review.</p></blockquote><p>ready</p>`;
		await h.engine.handle(buildMessage("m2", quoted));
		await h.engine.idle();
		expect(h.runner.runs[0]).toMatchObject({ url: PR_URL, spice: 2, comment: false });
	});

	test("logs why a message that mentions nothing the engine acts on is ignored", async () => {
		const h = setup();
		await h.engine.handle(buildMessage("m2", "hello there"));
		await h.engine.handle(buildMessage("m3", "ptal"));
		await h.engine.handle(
			buildMessage("m4", `ptal ${PR_URL}`, { from: { id: "b", name: "Bot", isBot: true } }),
		);
		expect(h.runner.runs).toEqual([]);
		const lines = h.log.lines.filter((l) => l.level === "info").map((l) => l.message);
		expect(lines).toContain("message m2 ignored: no owner token and no readiness phrase");
		expect(lines).toContain("message m3 ignored: readiness phrase but no PR link");
		expect(lines).toContain("message m4 ignored: bot message");
	});

	test("produces one run for two readiness messages while the job is pending", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({ runnerScript: () => gate.promise });
		h.state.markBlocked(PR_URL, "m0", { comment: false, fun: false }, CHAT_ID);
		await h.engine.handle(buildMessage("r1", `ptal ${PR_URL}`));
		await h.engine.handle(buildMessage("r2", `ptal ${PR_URL}`));
		await waitUntil(() => h.runner.runs.length === 1);
		gate.resolve(OK_RESULT);
		await h.engine.idle();
		expect(h.runner.runs).toHaveLength(1);
		expect(h.trail("r2")).toEqual([]);
		expect(h.state.get().handled.r2?.status).toBe("done");
	});

	test("prefers the trigger parser over the readiness parser", async () => {
		const h = setup();
		h.state.markBlocked(PR_URL, "m0", { spice: 1, comment: false, fun: false }, CHAT_ID);
		await h.engine.handle(reviewMessage("m2", PR_URL, "ptal ~spice 5"));
		await h.engine.idle();
		expect(h.runner.runs[0]).toMatchObject({ spice: 5 });
	});
});

describe("engine fun", () => {
	const gif = gifEntry("approved");
	const emoji = emojiEntry("approved");
	const baseText = (verdict: "approved" | "changes_requested", n = 12) =>
		`${VERDICT_LABELS[verdict].emoji} ${VERDICT_LABELS[verdict].word} #${n} ${pr(n)}`;

	test("posts one reply starting with the verdict emoji decorated with a gif entry", async () => {
		const h = setup({ funPool: [gif] });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		expect(h.replies()).toHaveLength(1);
		const reply = h.replies()[0];
		expect(reply?.text.startsWith(VERDICT_LABELS.approved.emoji)).toBe(true);
		const expected = decorateReply({ text: baseText("approved"), entry: gif });
		expect(reply?.text).toBe(expected.text);
		expect(reply?.card).toEqual(expected.card);
		expect(reply?.card?.body).toHaveLength(1);
	});

	test("puts no reaction on the bot's fun reply", async () => {
		const h = setup({ funPool: [gif] });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		expect(h.trail("sent-1")).toEqual([]);
	});

	test("skips the reply reaction when the reply fails", async () => {
		const h = setup({ funPool: [gif] });
		h.provider.failReplies = true;
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		expect(h.trail("m1")).toEqual([...FULL_TRAIL, "+approved"]);
		const others = h.provider.calls.filter((c) => c.op === "react" && c.messageId !== "m1");
		expect(others).toEqual([]);
	});

	test("decorates the reply with an extra line for an emoji entry", async () => {
		const h = setup({ funPool: [emoji] });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		const expected = decorateReply({ text: baseText("approved"), entry: emoji });
		expect(h.replies()[0]?.text).toBe(expected.text);
		expect(h.replies()[0]?.card).toBeUndefined();
	});

	test("selects the entry through the injected random", async () => {
		const pool = [gifEntry("approved", 1), gifEntry("approved", 2)];
		const h = setup({ funPool: pool, random: () => 0.999 });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		expect(h.replies()[0]?.card?.body[0]?.url).toBe(
			(pool[1] as { url: string }).url,
		);
	});

	test("uses the changes verdict entry for a changes_requested run", async () => {
		const entry = gifEntry("changes");
		const h = setup({
			funPool: [gif, entry],
			verdictScript: () => "changes_requested",
		});
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		expect(h.replies()[0]?.text).toBe(
			decorateReply({ text: baseText("changes_requested"), entry }).text,
		);
		expect(h.replies()[0]?.card?.body[0]?.url).toBe(
			(entry as { url: string }).url,
		);
		expect(funVerdictFor("changesRequested")).toBe("changes");
	});

	test("posts no reply without ~fun on a successful single PR", async () => {
		const h = setup({ funPool: [gif] });
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(h.replies()).toEqual([]);
	});

	test("decorates the existing CR reply on a failed run instead of adding a message", async () => {
		const entry = gifEntry("failed");
		const h = setup({ funPool: [gif, entry], runnerScript: () => FAILED_RUN });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		expect(h.replies()).toHaveLength(1);
		const expected = decorateReply({ text: crText(h, "CR-203"), entry });
		expect(h.replies()[0]?.text).toBe(expected.text);
		expect(h.replies()[0]?.card).toEqual(expected.card);
	});

	test("decorates a whole-job stacked failure reply with a failed entry", async () => {
		const entry = gifEntry("failed");
		const h = setup({ funPool: [entry] });
		h.stack.failWith = "CR-304";
		await h.engine.handle(reviewMessage("m1", pr(10), "~stacked ~fun"));
		await h.engine.idle();
		expect(h.replies()).toHaveLength(1);
		expect(h.replies()[0]?.card?.body[0]?.url).toBe(
			(entry as { url: string }).url,
		);
	});

	test("decorates the stacked summary with the aggregate verdict's entry", async () => {
		const h = setup({
			funPool: [gif, gifEntry("changes")],
			descendants: { [pr(10)]: [{ number: 11, url: pr(11) }] },
		});
		await h.engine.handle(reviewMessage("m1", pr(10), "~stacked ~fun"));
		await h.engine.idle();
		expect(h.replies()).toHaveLength(1);
		expect(h.replies()[0]?.text).toStartWith("Stacked review:");
		expect(h.replies()[0]?.card?.body[0]?.url).toBe(
			(gif as { url: string }).url,
		);
	});

	test("sends the reply undecorated when the pool has no entry for the verdict", async () => {
		const h = setup({ funPool: [gifEntry("failed")] });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		expect(h.replies()).toHaveLength(1);
		expect(h.replies()[0]?.text).toBe(baseText("approved"));
		expect(h.replies()[0]?.card).toBeUndefined();
	});

	test("sends the reply undecorated when the pool is empty", async () => {
		const h = setup({ funPool: [] });
		await h.engine.handle(reviewMessage("m1", PR_URL, "~fun"));
		await h.engine.idle();
		expect(h.replies()[0]?.text).toBe(baseText("approved"));
		expect(h.replies()[0]?.card).toBeUndefined();
	});
});

describe("job outcome log", () => {
	test("logs one info line with the verdict for a finished review", async () => {
		const h = setup();
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		const done = h.log.lines.filter((l) => l.level === "info" && l.message.startsWith("message m1 done:"));
		expect(done).toHaveLength(1);
		expect(done[0]?.message).toContain("approved");
	});

	test("logs the CR code for a failed review", async () => {
		const h = setup();
		h.runner.probeResult = { ok: false, code: "CR-201" };
		await h.engine.handle(reviewMessage("m1"));
		await h.engine.idle();
		expect(
			h.log.lines.some((l) => l.level === "info" && l.message.startsWith("message m1 failed: CR-201")),
		).toBe(true);
	});
});
