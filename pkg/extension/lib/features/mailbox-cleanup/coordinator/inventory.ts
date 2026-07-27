import {
	type MailboxInventory,
	validateMailboxInventory,
} from "@dg/common";

export function validateBoundedMailboxInventory(
	value: MailboxInventory,
): MailboxInventory {
	const inventory = validateMailboxInventory(value);
	return Object.freeze({
		...inventory,
		messages: Object.freeze(inventory.messages),
		folders: Object.freeze(inventory.folders),
		labels: Object.freeze(inventory.labels),
		filters: Object.freeze(inventory.filters),
	});
}
