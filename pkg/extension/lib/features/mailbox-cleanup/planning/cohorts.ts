import {
	type MailboxAgeBucket,
	type MailboxCohort,
	type MailboxInventory,
	type MailboxMessage,
	validateMailboxCohort,
} from "@dg/common";
import {
	throwIfMailboxAborted,
	yieldMailboxTask,
} from "../coordinator/abort";
import { validateBoundedMailboxInventory } from "../coordinator/inventory";

const DAY_MS = 24 * 60 * 60 * 1_000;

function ageBucket(
	message: MailboxMessage,
	capturedAt: number,
): MailboxAgeBucket {
	const age = Math.max(0, capturedAt - Date.parse(message.receivedAt));
	if (age <= 30 * DAY_MS) return "recent";
	if (age <= 180 * DAY_MS) return "older";
	return "old";
}

export function deriveMailboxCohorts(
	value: MailboxInventory,
): readonly MailboxCohort[] {
	return deriveMailboxCohortsFromValidatedInventory(
		validateBoundedMailboxInventory(value),
	);
}

export function deriveMailboxCohortsFromValidatedInventory(
	inventory: MailboxInventory,
): readonly MailboxCohort[] {
	const capturedAt = Date.parse(inventory.capturedAt);
	const groups = new Map<string, MailboxMessage[]>();
	for (const message of inventory.messages) {
		const bucket = ageBucket(message, capturedAt);
		const key = `${message.category}-${bucket}`;
		const members = groups.get(key) ?? [];
		members.push(message);
		groups.set(key, members);
	}
	return Object.freeze(
		[...groups.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([cohortKey, members]) => {
				const first = members[0];
				if (!first) throw new Error("Mailbox cohort cannot be empty");
				const bucket = ageBucket(first, capturedAt);
				const messageAliases = members
					.map((message) => message.alias)
					.sort();
				return validateMailboxCohort({
					schemaVersion: 1,
					cohortKey,
					category: first.category,
					ageBucket: bucket,
					messageAliases,
					suggestedActions: [],
				});
			}),
	);
}

export async function deriveMailboxCohortsFromValidatedInventoryAsync(
	inventory: MailboxInventory,
	signal: AbortSignal,
): Promise<readonly MailboxCohort[]> {
	throwIfMailboxAborted(signal);
	const capturedAt = Date.parse(inventory.capturedAt);
	const groups = new Map<string, MailboxMessage[]>();
	for (let index = 0; index < inventory.messages.length; index += 1) {
		const message = inventory.messages[index];
		if (message === undefined) continue;
		const bucket = ageBucket(message, capturedAt);
		const key = `${message.category}-${bucket}`;
		const members = groups.get(key) ?? [];
		members.push(message);
		groups.set(key, members);
		if ((index + 1) % 250 === 0) await yieldMailboxTask(signal);
	}
	throwIfMailboxAborted(signal);
	const cohorts = [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([cohortKey, members]) => {
			const first = members[0];
			if (!first) throw new Error("Mailbox cohort cannot be empty");
			return validateMailboxCohort({
				schemaVersion: 1,
				cohortKey,
				category: first.category,
				ageBucket: ageBucket(first, capturedAt),
				messageAliases: members
					.map((message) => message.alias)
					.sort(),
				suggestedActions: [],
			});
		});
	await yieldMailboxTask(signal);
	return Object.freeze(cohorts);
}
