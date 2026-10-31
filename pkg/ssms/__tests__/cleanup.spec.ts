import { describe, expect, test } from "bun:test";
import { applyCleanup } from "../src/cleanup/apply";
import { defaultCleanupConfig } from "../src/config/types";
import type { Conversation, SmsProvider } from "../src/types";

function conversation(overrides: Partial<Conversation>): Conversation {
	return {
		id: "c",
		title: "Ada",
		preview: "hello",
		pinned: false,
		savedContact: false,
		ageDays: 0,
		kind: "dm",
		...overrides,
	};
}

function fakeProvider() {
	const archived: string[] = [];
	const blocked: string[] = [];
	const deleted: string[] = [];
	const sent: string[] = [];
	const provider = {
		id: "google",
		capabilities: {},
		archive: async (input: { conversationId: string }) => {
			archived.push(input.conversationId);
			return { conversationId: input.conversationId, reason: "archived" };
		},
		blockAndReportSpam: async (input: { conversationId: string }) => {
			blocked.push(input.conversationId);
			return { conversationId: input.conversationId, reason: "blocked" };
		},
		sendDraft: async () => {
			sent.push("sent");
			return { draftId: "x", reason: "sent" as const };
		},
	} as unknown as SmsProvider;
	return { provider, archived, blocked, deleted, sent };
}

const rows = [
	conversation({ id: "pin", title: "Ada", preview: "50% off", pinned: true }),
	conversation({ id: "promo", title: "Shop", preview: "sale ends 50% off" }),
	conversation({ id: "scam", title: "Prize", preview: "you have won a gift card" }),
	conversation({ id: "huh", title: "Sam", preview: "are you free thursday" }),
];

describe("applyCleanup", () => {
	test("archives and blocks only clear-cut rows", async () => {
		const fake = fakeProvider();
		const actions = await applyCleanup(fake.provider, rows, defaultCleanupConfig(), false);
		expect(fake.archived).toEqual(["promo"]);
		expect(fake.blocked).toEqual(["scam"]);
		expect(fake.deleted).toEqual([]);
		expect(fake.sent).toEqual([]);
		expect(actions.find((item) => item.id === "huh")).toEqual({
			id: "huh",
			disposition: "ambiguous",
			reason: "ambiguous",
			applied: false,
		});
		expect(actions.find((item) => item.id === "pin")?.applied).toBe(false);
	});

	test("dry-run and an ambiguous flag still do not change the account", async () => {
		const config = defaultCleanupConfig();
		config.flag_ambiguous = false;
		config.allow_delete = true;
		config.allow_send = true;
		const dry = fakeProvider();
		const actions = await applyCleanup(dry.provider, rows, config, true);
		expect(dry.archived).toEqual([]);
		expect(dry.blocked).toEqual([]);
		expect(dry.sent).toEqual([]);
		expect(actions.filter((item) => item.applied)).toEqual([]);
		config.dry_run = true;
		const configured = fakeProvider();
		await applyCleanup(configured.provider, rows, config, false);
		expect(configured.archived).toEqual([]);
		expect(configured.blocked).toEqual([]);
	});

	test("a last-N-days scope drops older conversations", async () => {
		const config = defaultCleanupConfig();
		config.scope = "last_2_days";
		const fake = fakeProvider();
		const actions = await applyCleanup(
			fake.provider,
			[conversation({ id: "old", title: "Shop", preview: "sale ends 50% off", ageDays: 5 })],
			config,
			false,
		);
		expect(actions).toEqual([]);
		expect(fake.archived).toEqual([]);
	});
});
