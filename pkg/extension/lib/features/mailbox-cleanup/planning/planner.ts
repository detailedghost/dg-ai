import {
	type MailboxAction,
	type MailboxInventory,
} from "@dg/common";
import type {
	MailboxCaptureMetadata,
	MailboxCleanupChoiceSummary,
} from "../coordinator/contracts";
import {
	throwIfMailboxAborted,
	yieldMailboxTask,
} from "../coordinator/abort";
import { validateBoundedMailboxInventory } from "../coordinator/inventory";

function stableMessages(value: MailboxInventory) {
	return [...value.messages].sort((left, right) =>
		left.alias.localeCompare(right.alias),
	);
}

export function createMailboxCleanupChoices(
	value: MailboxInventory,
	metadata: MailboxCaptureMetadata = { tags: [], categories: [] },
): readonly MailboxCleanupChoiceSummary[] {
	return createMailboxCleanupChoicesFromValidatedInventory(
		validateBoundedMailboxInventory(value),
		metadata,
	);
}

export function createMailboxCleanupChoicesFromValidatedInventory(
	inventory: MailboxInventory,
	captureMetadata: MailboxCaptureMetadata = {
		tags: [],
		categories: [],
	},
): readonly MailboxCleanupChoiceSummary[] {
	const messages = stableMessages(inventory);
	const conservative: MailboxAction[] = messages
		.filter(
			(message) =>
				!message.read &&
				message.category !== "personal" &&
				message.category !== "transactional",
		)
		.map((message) => ({
			type: "mark_read",
			messageAlias: message.alias,
		}));
	const balanced: MailboxAction[] = [];
	for (const message of messages) {
		if (
			message.category === "personal" ||
			message.category === "transactional"
		) {
			if (!message.read) {
				balanced.push({
					type: "mark_read",
					messageAlias: message.alias,
				});
			}
		} else {
			balanced.push({
				type: "archive",
				messageAlias: message.alias,
			});
		}
	}
	const inboxZero: MailboxAction[] = inventory.partial
		? []
		: messages.map((message) => ({
				type: "archive",
				messageAlias: message.alias,
			}));
	const conservativeAliases = new Set(
		conservative.flatMap((action) =>
			"messageAlias" in action ? [action.messageAlias] : [],
		),
	);
	const balancedAliases = new Set(
		balanced.flatMap((action) =>
			"messageAlias" in action ? [action.messageAlias] : [],
		),
	);
	const metadata = Object.freeze({
		tagAliases: Object.freeze(
			captureMetadata.tags.map((item) => item.alias).sort(),
		),
		categoryAliases: Object.freeze(
			captureMetadata.categories.map((item) => item.alias).sort(),
		),
	});

	return Object.freeze([
		Object.freeze({
			id: "conservative" as const,
			sliderPosition: 0 as const,
			actions: Object.freeze(conservative),
			reviewMessageAliases: Object.freeze(
				messages
					.filter((message) => !conservativeAliases.has(message.alias))
					.map((message) => message.alias),
			),
			promisesInboxZero: false,
			partial: inventory.partial,
			metadata,
		}),
		Object.freeze({
			id: "balanced" as const,
			sliderPosition: 50 as const,
			actions: Object.freeze(balanced),
			reviewMessageAliases: Object.freeze(
				messages
					.filter((message) => !balancedAliases.has(message.alias))
					.map((message) => message.alias),
			),
			promisesInboxZero: false,
			partial: inventory.partial,
			metadata,
		}),
		Object.freeze({
			id: "inbox_zero" as const,
			sliderPosition: 100 as const,
			actions: Object.freeze(inboxZero),
			reviewMessageAliases: Object.freeze(
				inventory.partial
					? messages.map((message) => message.alias)
					: [],
			),
			promisesInboxZero: !inventory.partial,
			partial: inventory.partial,
			metadata,
		}),
	]);
}

export async function createMailboxCleanupChoicesFromValidatedInventoryAsync(
	inventory: MailboxInventory,
	captureMetadata: MailboxCaptureMetadata,
	signal: AbortSignal,
): Promise<readonly MailboxCleanupChoiceSummary[]> {
	throwIfMailboxAborted(signal);
	const messages = stableMessages(inventory);
	throwIfMailboxAborted(signal);
	const conservative: MailboxAction[] = [];
	const balanced: MailboxAction[] = [];
	const inboxZero: MailboxAction[] = [];
	const conservativeReview: string[] = [];
	const balancedReview: string[] = [];
	const inboxZeroReview: string[] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (message === undefined) continue;
		const conservativeApplies =
			!message.read &&
			message.category !== "personal" &&
			message.category !== "transactional";
		if (conservativeApplies) {
			conservative.push({
				type: "mark_read",
				messageAlias: message.alias,
			});
		} else {
			conservativeReview.push(message.alias);
		}
		const balancedArchives =
			message.category !== "personal" &&
			message.category !== "transactional";
		if (balancedArchives) {
			balanced.push({
				type: "archive",
				messageAlias: message.alias,
			});
		} else if (!message.read) {
			balanced.push({
				type: "mark_read",
				messageAlias: message.alias,
			});
		} else {
			balancedReview.push(message.alias);
		}
		if (inventory.partial) {
			inboxZeroReview.push(message.alias);
		} else {
			inboxZero.push({
				type: "archive",
				messageAlias: message.alias,
			});
		}
		if ((index + 1) % 250 === 0) await yieldMailboxTask(signal);
	}
	const metadata = Object.freeze({
		tagAliases: Object.freeze(
			captureMetadata.tags.map((item) => item.alias).sort(),
		),
		categoryAliases: Object.freeze(
			captureMetadata.categories.map((item) => item.alias).sort(),
		),
	});
	await yieldMailboxTask(signal);
	return Object.freeze([
		Object.freeze({
			id: "conservative" as const,
			sliderPosition: 0 as const,
			actions: Object.freeze(conservative),
			reviewMessageAliases: Object.freeze(conservativeReview),
			promisesInboxZero: false,
			partial: inventory.partial,
			metadata,
		}),
		Object.freeze({
			id: "balanced" as const,
			sliderPosition: 50 as const,
			actions: Object.freeze(balanced),
			reviewMessageAliases: Object.freeze(balancedReview),
			promisesInboxZero: false,
			partial: inventory.partial,
			metadata,
		}),
		Object.freeze({
			id: "inbox_zero" as const,
			sliderPosition: 100 as const,
			actions: Object.freeze(inboxZero),
			reviewMessageAliases: Object.freeze(inboxZeroReview),
			promisesInboxZero: !inventory.partial,
			partial: inventory.partial,
			metadata,
		}),
	]);
}
