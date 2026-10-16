import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { RelayAuthError } from "../src/providers/teams-relay";
import type { ChatEvent, ChatProvider } from "../src/providers/types";
import {
	DAEMON_ARGS,
	type DaemonHarness,
	type DaemonHarnessOptions,
	createDaemonHarness,
	failWith,
	holdOpen,
	termSignals,
	untilAbort,
} from "./daemon-harness";
import {
	CHAT_ID,
	abortable,
	buildIssue,
	buildMessage,
	createFakeSink,
	deferred,
	reviewMessage,
	waitUntil,
} from "./support/fakes";
import type { RunnerResult } from "./support/fakes";

type Script = (
	request: Parameters<ChatProvider["subscribe"]>[0],
) => AsyncGenerator<ChatEvent>;

const harnesses: DaemonHarness[] = [];

function setup(options: DaemonHarnessOptions = {}): DaemonHarness {
	const harness = createDaemonHarness(options);
	harnesses.push(harness);
	return harness;
}

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

function messageEvent(eventId: string, id = `m-${eventId}`, text = "hello"): ChatEvent {
	return { type: "message", eventId, message: buildMessage(id, text) };
}

function reactionEvent(eventId: string): ChatEvent {
	return {
		type: "reaction",
		eventId,
		reaction: {
			id: `a-${eventId}`,
			chatId: CHAT_ID,
			messageId: "m-x",
			from: { id: "u-1", name: "Owner", isBot: false },
			type: "1f440_eyes",
			action: "added",
			timestamp: "2026-10-14T12:00:00.000Z",
		},
	};
}

function lastEventId(h: DaemonHarness, chatId = CHAT_ID): string | undefined {
	if (!existsSync(h.paths.statePath)) return undefined;
	return (h.readState().lastEventIds as Record<string, string>)[chatId];
}

async function started(h: DaemonHarness): Promise<void> {
	await waitUntil(() => existsSync(h.paths.pidPath));
}

describe("serve startup", () => {
	test("exits 1 at entry without fetching a secret when the env's daemon is alive", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, DAEMON_ARGS);
		const { done } = h.startServe();
		expect(await done).toBe(1);
		expect(h.secrets).toHaveLength(0);
		expect(h.providers).toHaveLength(0);
		expect(existsSync(h.paths.pidPath)).toBe(true);
	});

	test("replaces a pidfile whose pid is not our daemon", async () => {
		const h = setup();
		h.writePidfile(4242);
		h.platform.alive.add(4242);
		h.platform.argsByPid.set(4242, "/usr/bin/vim notes.md");
		const { controller, done } = h.startServe();
		await waitUntil(() => h.readPidfile().pid === process.pid);
		controller.abort();
		expect(await done).toBe(0);
	});

	test("logs the env name as the first line", async () => {
		const h = setup({ envName: "prod" });
		const { controller, done } = h.startServe();
		await started(h);
		controller.abort();
		await done;
		expect(h.log.lines[0]?.message).toContain("prod");
	});

	test("writes the pidfile with pid, env, startedAt, and chats only after resolveChat succeeds", async () => {
		const h = setup();
		const { controller, done } = h.startServe({ chatId: "19:abc@thread.v2" });
		await started(h);
		expect(h.provider().resolveSeenPidfile).toEqual([false]);
		expect(h.provider().resolveRequests[0]?.chatId).toBe("19:abc@thread.v2");
		const pidfile = h.readPidfile();
		expect(pidfile).toMatchObject({
			pid: process.pid,
			env: "dev",
			chats: [{ id: "19:abc@thread.v2", topic: "Team Reviews" }],
		});
		expect(Number.isNaN(Date.parse(String(pidfile.startedAt)))).toBe(false);
		controller.abort();
		await done;
	});

	test("exits 1 before writing the pidfile when resolveChat throws", async () => {
		const h = setup({ resolveError: new Error("chat not found") });
		const { done } = h.startServe();
		expect(await done).toBe(1);
		expect(existsSync(h.paths.pidPath)).toBe(false);
		expect(h.log.lines.some((line) => line.message.includes("chat not found"))).toBe(true);
	});

	test("an RelayAuthError from resolveChat exits 1 naming the secret and never re-fetches it", async () => {
		const h = setup({ resolveError: new RelayAuthError(401) });
		const { done } = h.startServe();
		expect(await done).toBe(1);
		expect(h.secrets).toHaveLength(1);
		expect(existsSync(h.paths.pidPath)).toBe(false);
		expect(h.log.lines.some((line) => /secret/i.test(line.message))).toBe(true);
	});

	test("exits 1 before the pidfile when a configured reaction id is not in the Teams catalog", async () => {
		const h = setup({ listedReactions: [] });
		const { done } = h.startServe();
		expect(await done).toBe(1);
		expect(existsSync(h.paths.pidPath)).toBe(false);
		expect(h.log.lines.some((line) => line.message.includes(h.config.reactions.pending))).toBe(true);
	});

	test("never logs the fetched secret", async () => {
		const h = setup();
		const { controller, done } = h.startServe();
		await started(h);
		controller.abort();
		await done;
		for (const line of h.log.lines) expect(line.message).not.toContain("secret-1");
	});

	test("probes every runner and both verdict hosts without a url, then starts", async () => {
		const h = setup();
		const { controller, done } = h.startServe();
		await started(h);
		for (const runner of Object.values(h.runners)) expect(runner.probeCalls).toBe(1);
		expect(h.verdict.probes).toEqual(
			expect.arrayContaining([{ host: "github" }, { host: "gitlab" }]),
		);
		expect(h.verdict.probes.every((probe) => probe.url === undefined)).toBe(true);
		controller.abort();
		await done;
	});

	test("a failed probe logs a warning naming the runner and CR code, and the daemon still starts", async () => {
		const h = setup();
		h.runners.codex.probeResult = { ok: false, code: "CR-206" };
		h.verdict.probeResult = { ok: false, code: "CR-303" };
		const { controller, done } = h.startServe();
		await started(h);
		const warnings = h.log.lines.filter((line) => line.level === "warn").map((line) => line.message);
		expect(warnings.some((m) => m.includes("codex") && m.includes("CR-206"))).toBe(true);
		expect(warnings.some((m) => m.includes("CR-303"))).toBe(true);
		controller.abort();
		await done;
	});

	test("a probe that never settles is capped and does not block startup", async () => {
		const h = setup();
		h.runners.copilot.probe = () => new Promise(() => undefined);
		const { controller, done } = h.startServe();
		await started(h);
		controller.abort();
		expect(await done).toBe(0);
	});

	test("an abort during the probes skips recovery and the pidfile and exits 0", async () => {
		const h = setup();
		h.seedState((store) => store.markHandled("m0", "running"));
		const { controller, done } = h.startServe();
		h.runners.copilot.probe = async () => {
			controller.abort();
			return { ok: true };
		};
		expect(await done).toBe(0);
		expect(existsSync(h.paths.pidPath)).toBe(false);
		expect(h.provider().replies()).toHaveLength(0);
	});

	test("recovers an interrupted job at start with the failure reaction and a CR-205 reply", async () => {
		const h = setup();
		h.seedState((store) => store.markHandled("m0", "running"));
		const { controller, done } = h.startServe();
		await started(h);
		const provider = h.provider();
		expect(provider.calls.some((c) => c.op === "react" && c.messageId === "m0" && c.reactionId === h.config.reactions.failure)).toBe(true);
		expect(provider.replies().some((r) => r.text.startsWith("CR-205"))).toBe(true);
		controller.abort();
		await done;
	});
});

describe("serve event loop", () => {
	test("subscribes from state.lastEventIds", async () => {
		const h = setup();
		h.seedState((store) => store.setLastEventId(CHAT_ID, "e5"));
		const { controller, done } = h.startServe();
		await started(h);
		await waitUntil(() => h.provider().subscribeRequests.length === 1);
		expect(h.provider().subscribeRequests[0]?.resumeId).toBe("e5");
		expect(h.provider().subscribeRequests[0]?.chatId).toBe(CHAT_ID);
		controller.abort();
		await done;
	});

	test("subscribes without a resume id on a first run", async () => {
		const h = setup();
		const { controller, done } = h.startServe();
		await waitUntil(() => (h.providers[0]?.subscribeRequests.length ?? 0) === 1);
		expect(h.provider().subscribeRequests[0]?.resumeId).toBeUndefined();
		controller.abort();
		await done;
	});

	test("persists lastEventIds after each message event, even while a review still runs", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			runnerScript: (run) => abortable(run, gate.promise),
			scripts: [holdOpen(messageEvent("e1", "m1", "hi"), { type: "message", eventId: "e2", message: reviewMessage("m2") })],
		});
		const { controller, done } = h.startServe();
		await waitUntil(() => existsSync(h.paths.statePath) && lastEventId(h) === "e2");
		await waitUntil(() => h.runners.claude.runs.length === 1);
		controller.abort();
		await done;
	});

	test("a reaction event and an unknown event are skipped yet advance the last event id", async () => {
		const unknown = { type: "mystery", eventId: "e2" } as unknown as ChatEvent;
		const h = setup({ scripts: [holdOpen(reactionEvent("e1"), unknown)] });
		const { controller, done } = h.startServe();
		await waitUntil(() => existsSync(h.paths.statePath) && lastEventId(h) === "e2");
		const provider = h.provider();
		expect(provider.calls.filter((c) => c.op === "reply")).toHaveLength(0);
		expect(Object.keys(h.readState().handled as object)).toHaveLength(0);
		controller.abort();
		await done;
	});

	test("a $emoji prompt and a custom reaction on it save the id to config.json", async () => {
		const custom = "party;0-wus-d4-0123456789abcdef0123456789abcdef";
		const prompt = messageEvent("e1", "m-e1", "!owner $emoji approved");
		const reaction = reactionEvent("e2");
		if (reaction.type === "reaction") {
			reaction.reaction = {
				...reaction.reaction,
				messageId: "sent-1",
				type: custom,
				timestamp: "2999-01-01T00:00:00.000Z",
			};
		}
		const h = setup({
			configExtra: { address: { allowAnySender: true } },
			scripts: [holdOpen(prompt, reaction)],
		});
		const { controller, done } = h.startServe();
		await waitUntil(() => lastEventId(h) === "e2");
		expect(JSON.parse(readFileSync(h.paths.configPath, "utf8")).reactions).toEqual({ approved: custom });
		expect(h.provider().calls.filter((c) => c.op === "reply").map((c) => c.text)).toEqual([
			"React to this message with the emoji for approved.",
			"Saved :party: for approved.",
		]);
		controller.abort();
		await done;
	});

	test("a message whose handling throws does not advance the last event id, so a restart replays it", async () => {
		const broken = messageEvent("e1");
		if (broken.type === "message") broken.message = buildMessage("m-e1", "x", { from: undefined as never });
		const h = setup({ scripts: [holdOpen(broken)] });
		const { controller, done } = h.startServe();
		await waitUntil(() => h.log.lines.some((l) => l.level === "error" && l.message.includes("m-e1")));
		controller.abort();
		await done;
		expect(existsSync(h.paths.statePath) ? lastEventId(h) : undefined).toBeUndefined();
	});

	test("a gap event logs exactly one warning", async () => {
		const h = setup({ scripts: [holdOpen({ type: "gap" }, messageEvent("e1"))] });
		const { controller, done } = h.startServe();
		await waitUntil(() => existsSync(h.paths.statePath) && lastEventId(h) === "e1");
		const gapWarnings = h.log.lines.filter((l) => l.level === "warn" && /gap/i.test(l.message));
		expect(gapWarnings).toHaveLength(1);
		controller.abort();
		await done;
	});

	test("an ignored message still advances the last event id and is not run", async () => {
		const h = setup({ scripts: [holdOpen(messageEvent("e1", "m1", "just chatting"))] });
		const { controller, done } = h.startServe();
		await waitUntil(() => existsSync(h.paths.statePath) && lastEventId(h) === "e1");
		expect(h.runners.claude.runs).toHaveLength(0);
		controller.abort();
		await done;
	});
});

describe("serve shutdown", () => {
	test("an abort during a running job aborts the run, replies CR-205, removes the pidfile, and exits 0", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			runnerScript: (run) => abortable(run, gate.promise),
			scripts: [holdOpen({ type: "message", eventId: "e1", message: reviewMessage("m1") })],
		});
		const { controller, done } = h.startServe();
		await waitUntil(() => h.runners.claude.runs.length === 1);
		const startedAt = Date.now();
		controller.abort();
		expect(await done).toBe(0);
		expect(Date.now() - startedAt).toBeLessThan(10_000);
		expect(h.runners.claude.runs[0]?.signal.aborted).toBe(true);
		expect(h.provider().replies().some((r) => r.text.startsWith("CR-205"))).toBe(true);
		expect(existsSync(h.paths.pidPath)).toBe(false);
	});

	test("an idle abort exits 0 and removes the pidfile", async () => {
		const h = setup();
		const { controller, done } = h.startServe();
		await started(h);
		controller.abort();
		expect(await done).toBe(0);
		expect(existsSync(h.paths.pidPath)).toBe(false);
		expect(termSignals(h.platform)).toHaveLength(0);
	});

	test("stop is raced against a timer so a stuck runner cannot hold the exit forever", async () => {
		const gate = deferred<RunnerResult>();
		const h = setup({
			runnerScript: () => gate.promise,
			scripts: [holdOpen({ type: "message", eventId: "e1", message: reviewMessage("m1") })],
		});
		h.seams.stopTimeoutMs = 50;
		const { controller, done } = h.startServe();
		await waitUntil(() => h.runners.claude.runs.length === 1);
		controller.abort();
		expect(await done).toBe(0);
		expect(existsSync(h.paths.pidPath)).toBe(false);
		gate.resolve({ status: 0, signal: null, timedOut: false, aborted: false });
	});
});

describe("serve multiple chats", () => {
	const SECOND_CHAT = "chat-2";
	const twoChats = {
		chats: [{ id: CHAT_ID }, { id: SECOND_CHAT }],
	};
	const secondMessage = (eventId: string, id: string): ChatEvent => ({
		type: "message",
		eventId,
		message: buildMessage(id, "hello", { chatId: SECOND_CHAT }),
	});
	const byChat =
		(scripts: Record<string, Script>): Script =>
		(request) =>
			(scripts[request.chatId] ?? holdOpen())(request);

	test("records every chat in the pidfile and opens one subscription per chat", async () => {
		const h = setup({ configExtra: twoChats });
		const { controller, done } = h.startServe();
		await started(h);
		await waitUntil(() => h.provider().subscribeRequests.length === 2);
		expect(h.readPidfile().chats).toEqual([
			{ id: CHAT_ID, topic: "Team Reviews" },
			{ id: SECOND_CHAT, topic: "Team Reviews" },
		]);
		expect(h.provider().subscribeRequests.map((request) => request.chatId).sort()).toEqual([
			CHAT_ID,
			SECOND_CHAT,
		]);
		controller.abort();
		expect(await done).toBe(0);
	});

	test("resumes each subscription from its own last event id", async () => {
		const h = setup({ configExtra: twoChats });
		h.seedState((store) => {
			store.setLastEventId(CHAT_ID, "a5");
			store.setLastEventId(SECOND_CHAT, "b7");
		});
		const { controller, done } = h.startServe();
		await waitUntil(() => (h.providers[0]?.subscribeRequests.length ?? 0) === 2);
		const resume = Object.fromEntries(
			h.provider().subscribeRequests.map((request) => [request.chatId, request.resumeId]),
		);
		expect(resume).toEqual({ [CHAT_ID]: "a5", [SECOND_CHAT]: "b7" });
		controller.abort();
		await done;
	});

	test("migrates an old lastEventId to the first chat", async () => {
		const h = setup({ configExtra: twoChats });
		writeFileSync(h.paths.statePath, JSON.stringify({ lastEventId: "old" }));
		const { controller, done } = h.startServe();
		await waitUntil(() => (h.providers[0]?.subscribeRequests.length ?? 0) === 2);
		const resume = Object.fromEntries(
			h.provider().subscribeRequests.map((request) => [request.chatId, request.resumeId]),
		);
		expect(resume).toEqual({ [CHAT_ID]: "old", [SECOND_CHAT]: undefined });
		controller.abort();
		await done;
	});

	test("tracks the last event id per chat", async () => {
		const h = setup({
			configExtra: twoChats,
			scripts: [
				byChat({
					[CHAT_ID]: holdOpen(messageEvent("a1")),
					[SECOND_CHAT]: holdOpen(secondMessage("b1", "m-b1")),
				}),
			],
		});
		const { controller, done } = h.startServe();
		await waitUntil(
			() => lastEventId(h) === "a1" && lastEventId(h, SECOND_CHAT) === "b1",
		);
		controller.abort();
		await done;
	});

	test("keeps serving the other chat when one stream fails and logs the chat id", async () => {
		const h = setup({
			configExtra: twoChats,
			scripts: [
				byChat({
					[CHAT_ID]: failWith(new Error("stream broke")),
					[SECOND_CHAT]: holdOpen(secondMessage("b1", "m-b1")),
				}),
			],
		});
		const { controller, done } = h.startServe();
		await waitUntil(() => lastEventId(h, SECOND_CHAT) === "b1");
		expect(
			h.log.lines.some(
				(line) =>
					line.level === "error" &&
					line.message.includes(`chat ${CHAT_ID}`) &&
					line.message.includes("stream broke"),
			),
		).toBe(true);
		expect(existsSync(h.paths.pidPath)).toBe(true);
		controller.abort();
		expect(await done).toBe(0);
	});

	test("exits 1 when every chat stream fails", async () => {
		const h = setup({
			configExtra: twoChats,
			scripts: [failWith(new Error("stream broke"))],
		});
		const { done } = h.startServe();
		expect(await done).toBe(1);
		expect(existsSync(h.paths.pidPath)).toBe(false);
	});

	test("replies in the chat that sent the message while sharing one runner queue", async () => {
		const h = setup({
			configExtra: twoChats,
			scripts: [
				byChat({
					[CHAT_ID]: holdOpen({ type: "message", eventId: "a1", message: reviewMessage("m1") }),
					[SECOND_CHAT]: holdOpen({
						type: "message",
						eventId: "b1",
						message: buildMessage("m2", reviewMessage("m2", "https://github.com/o/r/pull/13").text, {
							chatId: SECOND_CHAT,
						}),
					}),
				}),
			],
		});
		const { controller, done } = h.startServe();
		await waitUntil(() => h.runners.claude.runs.length === 2);
		await waitUntil(() => (h.readState().handled as Record<string, { status: string }>).m2?.status === "done");
		expect(h.runners.claude.maxActive).toBe(1);
		const reacted = (messageId: string) =>
			h.provider().calls.find((call) => call.op === "react" && call.messageId === messageId)?.chatId;
		expect(reacted("m1")).toBe(CHAT_ID);
		expect(reacted("m2")).toBe(SECOND_CHAT);
		controller.abort();
		await done;
	});
});

describe("serve auth recovery", () => {
	test("one RelayAuthError from subscribe fetches a fresh secret, builds a new provider, and resumes from lastEventId", async () => {
		const h = setup({
			scripts: [failWith(new RelayAuthError(401), messageEvent("e1")), holdOpen()],
		});
		const { controller, done } = h.startServe();
		await waitUntil(() => h.providers.length === 2 && h.providers[1]!.subscribeRequests.length === 1);
		expect(h.secrets).toHaveLength(2);
		expect(h.providerSecrets).toEqual(["secret-1", "secret-2"]);
		expect(h.providers[1]!.subscribeRequests[0]?.resumeId).toBe("e1");
		controller.abort();
		expect(await done).toBe(0);
	});

	test("a second RelayAuthError logs and exits 1", async () => {
		const h = setup({
			scripts: [failWith(new RelayAuthError(401)), failWith(new RelayAuthError(403))],
		});
		const { done } = h.startServe();
		expect(await done).toBe(1);
		expect(h.secrets).toHaveLength(2);
		expect(h.log.lines.some((line) => line.level === "error")).toBe(true);
		expect(existsSync(h.paths.pidPath)).toBe(false);
	});
});

describe("serve maintenance", () => {
	const DAY_MS = 24 * 3_600_000;

	function oldJobLog(h: DaemonHarness, name: string): string {
		mkdirSync(h.paths.jobsDir, { recursive: true });
		const file = join(h.paths.jobsDir, name);
		writeFileSync(file, "log");
		const old = new Date(Date.now() - 15 * DAY_MS);
		utimesSync(file, old, old);
		return file;
	}

	test("deletes job logs older than 14 days on the maintenance timer", async () => {
		const h = setup();
		h.seams.maintenanceIntervalMs = 20;
		const { controller, done } = h.startServe();
		await started(h);
		const file = oldJobLog(h, "old.log");
		await waitUntil(() => !existsSync(file));
		controller.abort();
		await done;
	});

	test("stops the maintenance timer on shutdown", async () => {
		const h = setup();
		h.seams.maintenanceIntervalMs = 20;
		const { controller, done } = h.startServe();
		await started(h);
		controller.abort();
		await done;
		const file = oldJobLog(h, "late.log");
		await Bun.sleep(100);
		expect(existsSync(file)).toBe(true);
	});

	test("rotates the daemon log to .1 when it passes 10 MB while running", async () => {
		const h = setup();
		h.seams.logCheckIntervalMs = 20;
		const { controller, done } = h.startServe();
		await started(h);
		writeFileSync(h.paths.logPath, Buffer.alloc(10 * 1024 * 1024 + 1));
		await waitUntil(() => existsSync(`${h.paths.logPath}.1`) && statSync(h.paths.logPath).size === 0);
		controller.abort();
		await done;
	});

	test("flushes a held last event id to state.json on shutdown", async () => {
		const h = setup({ scripts: [holdOpen(reactionEvent("e1"), reactionEvent("e2"), reactionEvent("e3"))] });
		const { controller, done } = h.startServe();
		await waitUntil(() => existsSync(h.paths.statePath));
		await waitUntil(() => h.provider().subscribeRequests.length === 1);
		await Bun.sleep(50);
		controller.abort();
		await done;
		expect(lastEventId(h)).toBe("e3");
	});
});

describe("serve automation", () => {
	const ERROR_WATCH = {
		errorWatch: { enabled: true, pollMinutes: 7, providers: { datadog: { enabled: true } } },
	};
	const DEPS = { deps: { enabled: true, repos: [{ repo: "github.com/example-org/app" }] } };

	function gate(h: DaemonHarness) {
		const sleeps: number[] = [];
		h.seams.sleep = async (ms, signal) => {
			sleeps.push(ms);
			if (signal) await untilAbort(signal);
		};
		return sleeps;
	}

	function seedCursor(h: DaemonHarness) {
		h.seedState((store) => store.updateSink("datadog", { cursor: "2026-10-14T11:00:00.000Z" }));
	}

	test("starts every ticker when the workflows are on and stops them on shutdown", async () => {
		const h = setup({ configExtra: { ...ERROR_WATCH, ...DEPS } });
		const sleeps = gate(h);
		h.seams.sinks = [createFakeSink("datadog")];
		h.seams.capture = async () => ({ status: 0, signal: null, stdout: "[]", stderr: "" });
		const { controller, done } = h.startServe();
		await waitUntil(() => sleeps.length === 3);

		expect([...sleeps].sort((a, b) => a - b)).toEqual([60_000, 120_000, 7 * 60_000]);
		controller.abort();
		expect(await done).toBe(0);
	});

	test("starts no ticker when the workflows are off", async () => {
		const h = setup();
		const sleeps = gate(h);
		const sink = createFakeSink("datadog");
		h.seams.sinks = [sink];
		const { controller, done } = h.startServe();
		await started(h);
		controller.abort();
		await done;

		expect(sleeps).toEqual([]);
		expect(sink.polls).toEqual([]);
	});

	test("skips a provider with missing env and records the names", async () => {
		const h = setup({ configExtra: ERROR_WATCH });
		const sleeps = gate(h);
		h.seams.env = { DATADOG_API_KEY: "secret-value" };
		const { controller, done } = h.startServe();
		await started(h);
		controller.abort();
		await done;

		expect(sleeps).toEqual([]);
		const sinks = h.readState().sinks as Record<string, { lastError: string }>;
		expect(sinks.datadog?.lastError).toBe("missing environment variables: DATADOG_APP_KEY");
		expect(JSON.stringify(h.readState())).not.toContain("secret-value");
	});

	test("hands the sink detail report to the fix flow", async () => {
		const h = setup({ configExtra: ERROR_WATCH });
		gate(h);
		const sink = createFakeSink("datadog");
		sink.issues = [buildIssue("i-1")];
		h.seams.sinks = [sink];
		seedCursor(h);
		const { controller, done } = h.startServe();
		await waitUntil(() => (h.provider()?.dms.length ?? 0) > 0);

		expect(sink.details.map((issue) => issue.id)).toEqual(["i-1"]);
		expect(h.provider().dms[0]?.text).toContain("Error i-1");
		controller.abort();
		await done;
	});

	test("hands a minimal report to the fix flow when the detail call fails", async () => {
		const h = setup({ configExtra: ERROR_WATCH });
		gate(h);
		const sink = createFakeSink("datadog");
		sink.issues = [buildIssue("i-2")];
		sink.detail = async () => {
			throw new Error("detail unavailable");
		};
		h.seams.sinks = [sink];
		seedCursor(h);
		const { controller, done } = h.startServe();
		await waitUntil(() => (h.provider()?.dms.length ?? 0) > 0);

		expect(h.provider().dms[0]?.text).toContain("Error i-2");
		expect(h.log.lines.some((line) => line.message.includes("detail failed"))).toBe(true);
		controller.abort();
		await done;
	});
});
