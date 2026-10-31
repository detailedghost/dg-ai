import { describe, expect, test } from "bun:test";
import { classifyConversation, type Classifiable } from "../src/classifier/classify";
import { defaultCleanupConfig, type SmsCleanupConfig } from "../src/config/types";

function item(overrides: Partial<Classifiable> = {}): Classifiable {
	return {
		id: "c1",
		sender: "Ada",
		preview: "hello",
		pinned: false,
		savedContact: false,
		ageDays: 0,
		...overrides,
	};
}

describe("classifyConversation", () => {
	test("keep rules win over spam and archive", () => {
		const config = defaultCleanupConfig();
		config.keep.user_keep_list = ["Ada"];
		config.block_and_report_spam.user_spam_list = ["Ada"];
		config.archive.user_archive_list = ["Ada"];
		expect(classifyConversation(item({ pinned: true, preview: "you have won" }), config)).toEqual({
			id: "c1",
			disposition: "keep",
			reason: "pinned",
		});
		expect(classifyConversation(item({ preview: "you have won" }), config)).toEqual({
			id: "c1",
			disposition: "keep",
			reason: "user-keep",
		});
		expect(
			classifyConversation(item({ sender: "Pharmacy", preview: "fundraising tonight" }), config),
		).toEqual({ id: "c1", disposition: "keep", reason: "health" });
		expect(
			classifyConversation(
				item({ sender: "Mom", savedContact: true, preview: "50% off" }),
				config,
			),
		).toEqual({
			id: "c1",
			disposition: "keep",
			reason: "personal",
		});
	});

	test("a confirmed legitimate sender is not spam", () => {
		const config = defaultCleanupConfig();
		config.never_misclassify_as_spam = ["Campaign"];
		expect(
			classifyConversation(item({ sender: "Campaign", preview: "donate to the race" }), config),
		).toEqual({ id: "c1", disposition: "keep", reason: "never-misclassify" });
	});

	test("groups are tracked and not archived", () => {
		const config = defaultCleanupConfig();
		config.groups.dev = ["Pager"];
		expect(classifyConversation(item({ sender: "Pager", preview: "50% off" }), config)).toEqual({
			id: "c1",
			disposition: "group",
			reason: "dev",
			group: "dev",
		});
	});

	test("clear-cut spam and archive rules name their reason", () => {
		const config = defaultCleanupConfig();
		expect(classifyConversation(item({ preview: "you have won a gift card" }), config)).toEqual({
			id: "c1",
			disposition: "spam",
			reason: "scam",
		});
		expect(classifyConversation(item({ preview: "donate to the campaign" }), config)).toEqual({
			id: "c1",
			disposition: "spam",
			reason: "political",
		});
		config.block_and_report_spam.user_spam_list = ["SpamCo"];
		expect(classifyConversation(item({ sender: "SpamCo" }), config)).toEqual({
			id: "c1",
			disposition: "spam",
			reason: "user-spam",
		});
		expect(classifyConversation(item({ preview: "sale ends 50% off" }), config)).toEqual({
			id: "c1",
			disposition: "archive",
			reason: "promo",
		});
		expect(classifyConversation(item({ preview: "package arrived" }), config)).toEqual({
			id: "c1",
			disposition: "archive",
			reason: "delivery",
		});
	});

	test("a code is archived only once it is older than the configured days", () => {
		const config = defaultCleanupConfig();
		expect(config.archive.expired_codes_older_than_days).toBe(3);
		expect(
			classifyConversation(item({ preview: "your code is 123456", ageDays: 3 }), config).reason,
		).toBe("ambiguous");
		expect(
			classifyConversation(item({ preview: "your code is 123456", ageDays: 4 }), config),
		).toEqual({ id: "c1", disposition: "archive", reason: "expired-code" });
	});

	test("a past nonmedical reminder archives and a fresh one stays ambiguous", () => {
		const config = defaultCleanupConfig();
		expect(classifyConversation(item({ preview: "reminder: dentist", ageDays: 1 }), config).reason).toBe(
			"ambiguous",
		);
		expect(classifyConversation(item({ preview: "reminder: dentist", ageDays: 2 }), config)).toEqual({
			id: "c1",
			disposition: "archive",
			reason: "reminder",
		});
	});

	test("anything else is ambiguous", () => {
		expect(classifyConversation(item(), defaultCleanupConfig())).toEqual({
			id: "c1",
			disposition: "ambiguous",
			reason: "ambiguous",
		});
	});
});

describe("classify config toggles", () => {
	test("turning a rule off stops that disposition", () => {
		const config: SmsCleanupConfig = defaultCleanupConfig();
		config.block_and_report_spam.obvious_scams = false;
		expect(classifyConversation(item({ preview: "you have won" }), config).disposition).toBe(
			"ambiguous",
		);
	});
});
