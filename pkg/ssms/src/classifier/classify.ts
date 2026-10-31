import type { SmsCleanupConfig } from "../config/types";

export type Disposition = "keep" | "group" | "archive" | "spam" | "ambiguous";

export interface Classifiable {
	id: string;
	sender: string;
	preview: string;
	pinned: boolean;
	savedContact: boolean;
	ageDays: number;
}

export interface Classification {
	id: string;
	disposition: Disposition;
	reason: string;
	group?: "dev" | "personal_notifications";
}

const HEALTH = ["pharmacy", "prescription", "doctor", "lab result", "medical"];
const POLITICAL = ["fundraising", "campaign", "donate to", "vote for"];
const SCAM = ["verify your account", "gift card", "you have won", "urgent wire"];
const PROMO = ["% off", "sale ends", "unsubscribe", "promo code"];
const DELIVERY = ["delivered", "out for delivery", "package arrived"];
const CODE = ["verification code", "your code is", "one-time code"];
const REMINDER = ["reminder:"];

function haystack(item: Classifiable): string {
	return `${item.sender}\n${item.preview}`.toLowerCase();
}

function hasAny(text: string, needles: readonly string[]): boolean {
	return needles.some((needle) => text.includes(needle));
}

function listed(list: readonly string[], sender: string): boolean {
	const key = sender.toLowerCase();
	return list.some((entry) => entry.toLowerCase() === key);
}

export function classifyConversation(
	item: Classifiable,
	config: SmsCleanupConfig,
): Classification {
	const text = haystack(item);
	const spamListed = listed(config.block_and_report_spam.user_spam_list, item.sender);
	const scam =
		config.block_and_report_spam.obvious_scams && hasAny(text, SCAM);
	const political =
		config.block_and_report_spam.political_campaign_poll_fundraising &&
		hasAny(text, POLITICAL);
	const wouldSpam = spamListed || scam || political;
	if (listed(config.never_misclassify_as_spam, item.sender) && wouldSpam) {
		return { id: item.id, disposition: "keep", reason: "never-misclassify" };
	}
	if (config.keep.pinned && item.pinned) {
		return { id: item.id, disposition: "keep", reason: "pinned" };
	}
	if (listed(config.keep.user_keep_list, item.sender)) {
		return { id: item.id, disposition: "keep", reason: "user-keep" };
	}
	if (config.keep.health && hasAny(text, HEALTH)) {
		return { id: item.id, disposition: "keep", reason: "health" };
	}
	if (config.keep.personal_and_family && item.savedContact) {
		return { id: item.id, disposition: "keep", reason: "personal" };
	}
	if (listed(config.groups.dev, item.sender)) {
		return { id: item.id, disposition: "group", reason: "dev", group: "dev" };
	}
	if (listed(config.groups.personal_notifications, item.sender)) {
		return {
			id: item.id,
			disposition: "group",
			reason: "personal-notifications",
			group: "personal_notifications",
		};
	}
	if (wouldSpam) {
		return {
			id: item.id,
			disposition: "spam",
			reason: spamListed ? "user-spam" : scam ? "scam" : "political",
		};
	}
	if (listed(config.archive.user_archive_list, item.sender)) {
		return { id: item.id, disposition: "archive", reason: "user-archive" };
	}
	const expired =
		hasAny(text, CODE) && item.ageDays > config.archive.expired_codes_older_than_days;
	if (expired) return { id: item.id, disposition: "archive", reason: "expired-code" };
	if (config.archive.business_promos && hasAny(text, PROMO)) {
		return { id: item.id, disposition: "archive", reason: "promo" };
	}
	if (config.archive.completed_delivery_notices && hasAny(text, DELIVERY)) {
		return { id: item.id, disposition: "archive", reason: "delivery" };
	}
	if (
		config.archive.past_nonmedical_reminders &&
		hasAny(text, REMINDER) &&
		item.ageDays > 1 &&
		!hasAny(text, HEALTH)
	) {
		return { id: item.id, disposition: "archive", reason: "reminder" };
	}
	return { id: item.id, disposition: "ambiguous", reason: "ambiguous" };
}
