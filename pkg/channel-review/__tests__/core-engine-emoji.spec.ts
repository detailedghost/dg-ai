import { afterEach, describe, expect, test } from "bun:test";
import { ownerName, replyText } from "../src/errors";
import type { ChatReaction } from "../src/providers/types";
import type { EngineHarness, HarnessOptions } from "./support/fakes";
import {
	BOT_NAME,
	buildMessage,
	CHAT_ID,
	createEngineHarness,
	OTHER_ID,
	OWNER_ID,
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

const CUSTOM_ID = "party;0-wus-d4-0123456789abcdef0123456789abcdef";
const SLOT_LIST =
	"Pick a reaction slot: pending, inProgress, approved, changesRequested, comment, failure. For example: $emoji approved";

function emojiMessage(id: string, args = "", senderId = OWNER_ID) {
	return buildMessage(id, `<p><at>${BOT_NAME}</at> !owner $emoji ${args}</p>`, {
		from: { id: senderId, name: "Owner", isBot: false },
	});
}

function reaction(overrides: Partial<ChatReaction> = {}): ChatReaction {
	return {
		id: "r-1",
		chatId: CHAT_ID,
		messageId: "sent-1",
		from: { id: OWNER_ID, name: "Owner", isBot: false },
		type: CUSTOM_ID,
		action: "added",
		timestamp: "2026-10-14T12:00:01.000Z",
		...overrides,
	};
}

const texts = (h: EngineHarness) => h.replies().map((reply) => reply.text);

describe("$emoji", () => {
	test("prompts, then saves and applies a custom reaction with no reaction on its own reply", async () => {
		const h = setup();
		await h.engine.handle(emojiMessage("m1", "approved"));
		expect(texts(h)).toEqual([
			"React to this message with the emoji for approved.",
		]);

		await h.engine.handleReaction(reaction());

		expect(h.persisted).toEqual([{ slot: "approved", id: CUSTOM_ID }]);
		expect(h.config.reactions.approved).toBe(CUSTOM_ID);
		expect(texts(h).at(-1)).toBe("Saved :party: for approved.");
		expect(h.provider.calls.filter((call) => call.op === "react")).toEqual([]);
		expect(h.timers[0]?.canceled).toBe(true);
	});

	test("uses the saved reaction for the next review at once", async () => {
		const h = setup();
		await h.engine.handle(emojiMessage("m1", "pending"));
		await h.engine.handleReaction(reaction());
		await h.engine.handle(
			buildMessage(
				"m2",
				`<p><at>${BOT_NAME}</at> !owner $review https://github.com/o/r/pull/12</p>`,
			),
		);
		expect(h.provider.calls).toContainEqual({
			op: "react",
			chatId: CHAT_ID,
			messageId: "m2",
			reactionId: CUSTOM_ID,
		});
	});

	test("accepts the progress alias and any case for the slot", async () => {
		const h = setup();
		await h.engine.handle(emojiMessage("m1", "PROGRESS"));
		await h.engine.handleReaction(reaction());
		expect(h.persisted).toEqual([{ slot: "inProgress", id: CUSTOM_ID }]);
	});

	test.each([
		["a bot reaction", { from: { id: "bot", name: BOT_NAME, isBot: true } }],
		["a reaction on another message", { messageId: "other" }],
		["a built-in emoji", { type: "1f44d_thumbsup" }],
		["a removed reaction", { action: "removed" as const }],
	])("ignores %s and keeps waiting", async (_label, overrides) => {
		const h = setup();
		await h.engine.handle(emojiMessage("m1", "approved"));
		await h.engine.handleReaction(reaction(overrides));
		expect(h.persisted).toEqual([]);
		expect(h.config.reactions.approved).toBe("2705_whiteheavycheckmark");

		await h.engine.handleReaction(reaction());
		expect(h.persisted).toEqual([{ slot: "approved", id: CUSTOM_ID }]);
	});

	test("ignores reactions when no $emoji is pending", async () => {
		const h = setup();
		await h.engine.handleReaction(reaction());
		expect(h.persisted).toEqual([]);
		expect(h.provider.calls).toEqual([]);
	});

	test("replies that nothing was saved after 5 minutes", async () => {
		const h = setup();
		await h.engine.handle(emojiMessage("m1", "comment"));
		expect(h.timers.map((timer) => timer.ms)).toEqual([300_000]);

		await h.timers[0]?.task();
		expect(texts(h).at(-1)).toBe(
			"No custom emoji arrived within 5 minutes, so nothing was saved for comment.",
		);
		await h.engine.handleReaction(reaction());
		expect(h.persisted).toEqual([]);
	});

	test("a second $emoji replaces the first", async () => {
		const h = setup();
		await h.engine.handle(emojiMessage("m1", "approved"));
		await h.engine.handle(emojiMessage("m2", "failure"));
		expect(h.timers[0]?.canceled).toBe(true);

		await h.engine.handleReaction(reaction({ messageId: "sent-1" }));
		expect(h.persisted).toEqual([]);
		await h.engine.handleReaction(reaction({ messageId: "sent-2" }));
		expect(h.persisted).toEqual([{ slot: "failure", id: CUSTOM_ID }]);
	});

	test("does not apply the id when saving fails", async () => {
		const h = setup({ persistError: new Error("disk full") });
		await h.engine.handle(emojiMessage("m1", "approved"));
		await h.engine.handleReaction(reaction());
		expect(h.config.reactions.approved).toBe("2705_whiteheavycheckmark");
		expect(texts(h).at(-1)).toBe(
			"I couldn't save the emoji for approved, so nothing changed.",
		);
	});

	test.each([
		["no slot", ""],
		["an unknown slot", "sparkles"],
	])("replies with the slot list for %s", async (_label, args) => {
		const h = setup();
		await h.engine.handle(emojiMessage("m1", args));
		expect(texts(h)).toEqual([SLOT_LIST]);
		expect(h.timers).toEqual([]);
	});

	test("refuses a sender outside owner.senderIds with CR-107", async () => {
		const h = setup();
		await h.engine.handle(emojiMessage("m1", "approved", OTHER_ID));
		expect(texts(h)).toEqual([
			replyText("CR-107", { owner: ownerName(h.config.owner.token) }),
		]);
		expect(h.trail("m1")).toEqual(["+failure"]);
		expect(h.timers).toEqual([]);
		expect(h.log.lines).toContainEqual({
			level: "info",
			message: `message m1 $emoji refused: sender Owner (${OTHER_ID}) is not in owner.senderIds`,
		});
	});

	test("lets any sender run it when address.allowAnySender is on", async () => {
		const h = setup({ configExtra: { address: { allowAnySender: true } } });
		await h.engine.handle(emojiMessage("m1", "approved", OTHER_ID));
		expect(texts(h)).toEqual([
			"React to this message with the emoji for approved.",
		]);
	});
});
