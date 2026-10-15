import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveEnv } from "../src/config";
import type { connect } from "../src/daemon";
import { captureEmoji } from "../src/emojis";
import { channelReviewPaths } from "../src/paths";
import type { ChatEvent, ChatProvider } from "../src/providers/types";
import {
	CHAT_ID,
	type TempHome,
	createRecordedLog,
	createTempHome,
	deferred,
	minimalConfigJson,
	writeConfigFile,
} from "./support/fakes";

type Connect = typeof connect;
type SubscribeRequest = Parameters<ChatProvider["subscribe"]>[0];

const HEX = "0123456789abcdef0123456789abcdef";
const STARTED = new Date("2026-10-14T12:00:00.000Z");
const LATER = "2026-10-14T12:00:05.000Z";
const EARLIER = "2026-10-14T11:59:00.000Z";

const customId = (name: string, digits = 3, hex = HEX) =>
	`${name};0-cus-d${digits}-${hex}`;

type ReactionOptions = {
	messageId?: string;
	type?: string;
	action?: "added" | "removed";
	isBot?: boolean;
	timestamp?: string;
};

function reactionEvent(options: ReactionOptions = {}): ChatEvent {
	const messageId = options.messageId ?? "m1";
	return {
		type: "reaction",
		eventId: `${messageId}:${options.action ?? "added"}:0`,
		reaction: {
			id: `${messageId}-reaction`,
			chatId: CHAT_ID,
			messageId,
			from: { id: "u1", name: "Owner", isBot: options.isBot ?? false },
			type: options.type ?? customId("progress"),
			action: options.action ?? "added",
			timestamp: options.timestamp ?? LATER,
		},
	};
}

let home: TempHome;
let configPath: string;

beforeEach(() => {
	home = createTempHome();
	configPath = writeConfigFile(
		home.dir,
		minimalConfigJson({
			chat: { topic: "Team Reviews" },
			reactions: { inProgress: "23f1_stopwatch", approved: "2705_whiteheavycheckmark" },
		}),
	);
});

afterEach(() => {
	home.cleanup();
});

function setup(
	options: {
		events?: ChatEvent[];
		messageIds?: string[];
		daemonRunning?: boolean;
	} = {},
) {
	const order: string[] = [];
	const replies: { chatId: string; text: string }[] = [];
	const subscribeRequests: SubscribeRequest[] = [];
	const connectArgs: Parameters<Connect>[0][] = [];
	const out: string[] = [];
	const err: string[] = [];
	const replied = deferred<void>();
	const log = createRecordedLog();

	const provider: ChatProvider = {
		resolveChat: async ({ chatId }) => ({ id: chatId ?? CHAT_ID }),
		subscribe: (request) => {
			subscribeRequests.push(request);
			return (async function* () {
				order.push("subscribe");
				await replied.promise;
				for (const event of options.events ?? []) yield event;
				await new Promise<void>((resolve) => {
					if (request.signal.aborted) resolve();
					else request.signal.addEventListener("abort", () => resolve(), { once: true });
				});
			})();
		},
		react: async () => {},
		unreact: async () => {},
		reply: async ({ chatId, text }) => {
			order.push("reply");
			replies.push({ chatId, text });
			replied.resolve();
			return { messageIds: options.messageIds ?? ["m1"] };
		},
		listReactions: async () => [],
	};

	const config = loadConfig(configPath);
	const env = resolveEnv(config);
	const connectSeam: Connect = async (args) => {
		connectArgs.push(args);
		return { secret: "secret-1", provider, chats: [{ id: args.overrides.chatId ?? CHAT_ID }] };
	};

	const seams = {
		connect: connectSeam,
		now: () => STARTED,
		daemonRunning: async () => options.daemonRunning ?? false,
	};

	const run = (overrides: Partial<Parameters<typeof captureEmoji>[0]> = {}) =>
		captureEmoji({
			config,
			env,
			slot: "progress",
			configPath,
			timeoutMs: 50,
			io: { out: (line) => out.push(line), err: (line) => err.push(line) },
			log,
			seams,
			...overrides,
		});

	return { run, seams, order, replies, subscribeRequests, connectArgs, out, err, log };
}

const readConfig = () => readFileSync(configPath, "utf8");

describe("captureEmoji success", () => {
	test("skips a reaction on another message and a built-in like, then saves the custom id to reactions.inProgress", async () => {
		const target = customId("progress");
		const s = setup({
			events: [
				reactionEvent({ messageId: "m0", type: customId("other") }),
				reactionEvent({ type: "like" }),
				reactionEvent({ type: target }),
			],
		});
		const code = await s.run();
		expect(code).toBe(0);
		const saved = JSON.parse(readConfig());
		expect(saved.reactions.inProgress).toBe(target);
		expect(saved.reactions.approved).toBe("2705_whiteheavycheckmark");
		expect(s.out.join("\n")).toContain(target);
	});

	test("changes only the saved slot line of a tab-indented config", async () => {
		const target = customId("progress");
		const before = readConfig();
		const s = setup({ events: [reactionEvent({ type: target })] });
		await s.run();
		const beforeLines = before.split("\n");
		const afterLines = readConfig().split("\n");
		expect(afterLines).toHaveLength(beforeLines.length);
		const changed = afterLines.filter((line, index) => line !== beforeLines[index]);
		expect(changed).toEqual([`\t\t"inProgress": "${target}",`]);
	});

	test("saves the approved slot to reactions.approved", async () => {
		const target = customId("approved", 12, HEX.toUpperCase());
		const s = setup({ events: [reactionEvent({ type: target })] });
		const code = await s.run({ slot: "approved" });
		expect(code).toBe(0);
		expect(JSON.parse(readConfig()).reactions.approved).toBe(target);
		expect(JSON.parse(readConfig()).reactions.inProgress).toBe("23f1_stopwatch");
	});

	test("accepts a reaction from any human, not only the owner", async () => {
		const event = reactionEvent({ type: customId("progress") });
		if (event.type === "reaction") event.reaction.from = { id: "someone-else", isBot: false };
		const s = setup({ events: [event] });
		expect(await s.run()).toBe(0);
	});

	test("accepts a reaction whose timestamp equals startedAt", async () => {
		const target = customId("progress");
		const s = setup({ events: [reactionEvent({ type: target, timestamp: STARTED.toISOString() })] });
		expect(await s.run()).toBe(0);
		expect(JSON.parse(readConfig()).reactions.inProgress).toBe(target);
	});

	test("opens subscribe with no resume id before it posts the prompt", async () => {
		const s = setup({ events: [reactionEvent()] });
		await s.run();
		expect(s.order).toEqual(["subscribe", "reply"]);
		expect(s.subscribeRequests).toHaveLength(1);
		expect(s.subscribeRequests[0]?.resumeId).toBeUndefined();
		expect(s.subscribeRequests[0]?.chatId).toBe(CHAT_ID);
	});

	test("posts one prompt naming the slot and the timeout in seconds", async () => {
		const s = setup({ events: [reactionEvent()] });
		await s.run({ timeoutMs: 90_000 });
		expect(s.replies).toHaveLength(1);
		expect(s.replies[0]?.chatId).toBe(CHAT_ID);
		expect(s.replies[0]?.text).toBe(
			"Review Bot needs the progress emoji: react to this message with it within 90 seconds",
		);
	});

	test("aborts the subscription signal on success", async () => {
		const s = setup({ events: [reactionEvent()] });
		await s.run();
		expect(s.subscribeRequests[0]?.signal.aborted).toBe(true);
	});

	test("passes the chat id override to connect", async () => {
		const s = setup({ events: [reactionEvent()] });
		await s.run({ chatId: "19:flag@thread.v2" });
		expect(s.connectArgs[0]?.overrides).toEqual({ chatId: "19:flag@thread.v2" });
		expect(s.replies[0]?.chatId).toBe("19:flag@thread.v2");
	});

	test("connects with only the first configured chat", async () => {
		writeConfigFile(
			home.dir,
			minimalConfigJson({ chats: [{ topic: "First" }, { topic: "Second" }] }),
		);
		const s = setup({ events: [reactionEvent()] });
		await s.run();
		expect(s.connectArgs[0]?.config.chats).toEqual([
			{ topic: "First", id: undefined },
		]);
	});

});

describe("captureEmoji skipped events", () => {
	test.each([
		["a reaction from a bot", { isBot: true }],
		["a removed action", { action: "removed" as const }],
		["a timestamp before startedAt", { timestamp: EARLIER }],
		["a reaction on another message", { messageId: "m0" }],
		["a built-in reaction type", { type: "like" }],
		["a malformed custom id", { type: "progress;0-cus-d4-abc" }],
	])("skips %s and ends in the timeout remedy with config.json unchanged", async (_name, options) => {
		const before = readConfig();
		const s = setup({ events: [reactionEvent(options)] });
		const code = await s.run();
		expect(code).toBe(1);
		expect(readConfig()).toBe(before);
		expect(s.err.join("\n")).toContain("progress: no reaction event received");
		expect(s.subscribeRequests[0]?.signal.aborted).toBe(true);
	});

	test("logs a malformed custom id with the id and skips it", async () => {
		const s = setup({ events: [reactionEvent({ type: "progress;0-cus-d4-abc" })] });
		await s.run();
		expect(s.log.lines.some((line) => line.message.includes("progress;0-cus-d4-abc"))).toBe(true);
	});

	test("ignores message and gap events", async () => {
		const target = customId("progress");
		const s = setup({
			events: [
				{ type: "gap" },
				{
					type: "message",
					eventId: "e1",
					message: {
						id: "m1",
						chatId: CHAT_ID,
						from: { isBot: false },
						text: "hello",
						timestamp: LATER,
					},
				},
				reactionEvent({ type: target }),
			],
		});
		expect(await s.run()).toBe(0);
		expect(JSON.parse(readConfig()).reactions.inProgress).toBe(target);
	});
});

describe("captureEmoji failure", () => {
	test("a timeout exits 1, names the slot and the remedy, and leaves config.json unchanged", async () => {
		const before = readConfig();
		const s = setup();
		const code = await s.run({ slot: "approved", timeoutMs: 30 });
		expect(code).toBe(1);
		expect(readConfig()).toBe(before);
		const message = s.err.join("\n");
		expect(message).toContain("approved");
		expect(message).toContain("no reaction event received");
		expect(message).toContain("emojis set");
	});

	test("aborts the subscription signal on timeout", async () => {
		const s = setup();
		await s.run({ timeoutMs: 30 });
		expect(s.subscribeRequests[0]?.signal.aborted).toBe(true);
	});

	test("a reply that returns no message ids exits 1 before waiting and leaves config.json unchanged", async () => {
		const before = readConfig();
		const s = setup({ messageIds: [], events: [reactionEvent()] });
		const started = Date.now();
		const code = await s.run({ timeoutMs: 5_000 });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(code).toBe(1);
		expect(readConfig()).toBe(before);
		expect(s.err.join("\n")).toContain(
			"the relay returned no message id for the prompt; use emojis set",
		);
		expect(s.subscribeRequests[0]?.signal.aborted).toBe(true);
	});

	test("a connect failure propagates and leaves config.json unchanged", async () => {
		const before = readConfig();
		const s = setup();
		const failing: Connect = async () => {
			throw new Error("AWS SSO session expired");
		};
		await expect(
			s.run({
				seams: { connect: failing, now: () => STARTED, daemonRunning: async () => false },
			}),
		).rejects.toThrow("AWS SSO session expired");
		expect(readConfig()).toBe(before);
	});
});

describe("captureEmoji SIGINT", () => {
	test("a SIGINT aborts the subscription, exits 1, and leaves config.json unchanged", async () => {
		const before = readConfig();
		const s = setup();
		const running = s.run({ timeoutMs: 5_000 });
		await Bun.sleep(20);
		process.emit("SIGINT");
		expect(await running).toBe(1);
		expect(s.subscribeRequests[0]?.signal.aborted).toBe(true);
		expect(readConfig()).toBe(before);
	});

	test("removes its SIGINT listener when it finishes", async () => {
		const listeners = process.listenerCount("SIGINT");
		await setup({ events: [reactionEvent()] }).run();
		expect(process.listenerCount("SIGINT")).toBe(listeners);
	});
});

describe("captureEmoji daemon notice", () => {
	test("prints restart the daemon to apply when a daemon runs", async () => {
		const s = setup({ events: [reactionEvent()], daemonRunning: true });
		await s.run();
		expect(s.out.join("\n")).toContain("restart the daemon to apply");
	});

	test("prints no restart notice when no daemon runs", async () => {
		const s = setup({ events: [reactionEvent()], daemonRunning: false });
		await s.run();
		expect(`${s.out.join("\n")}${s.err.join("\n")}`).not.toContain("restart the daemon");
	});
});

describe("captureEmoji pid path", () => {
	test("checks the pidfile from channelReviewPaths, not the config directory", async () => {
		const checked: string[] = [];
		const system = { env: { DG_HOME: join(home.dir, "other-state") } };
		const s = setup({ events: [reactionEvent()] });
		await s.run({
			system,
			seams: {
				...s.seams,
				daemonRunning: async (pidPath) => {
					checked.push(pidPath);
					return true;
				},
			},
		});
		expect(checked).toEqual([channelReviewPaths("dev", system).pidPath]);
		expect(s.out.join("\n")).toContain("restart the daemon to apply");
	});
});

describe("captureEmoji config path", () => {
	test("writes only into the given config file", async () => {
		const s = setup({ events: [reactionEvent()] });
		await s.run();
		expect(readFileSync(join(home.dir, "config.json"), "utf8")).toContain("progress;0-cus-d3-");
	});
});
