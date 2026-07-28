import {
	type MailboxAction,
	type MailboxCanonicalAction,
	type MailboxFingerprint,
	type MailboxInventory,
	type MailboxRevisionTargets,
	preflightMailboxValue,
	validateMailboxAction,
	validateCanonicalMailboxAction,
	validateMailboxFingerprint,
} from "@dg/common";
import {
	throwIfMailboxAborted,
	yieldMailboxTask,
} from "../coordinator/abort";
import {
	MAILBOX_CAPTURE_LIMITS,
	type MailboxCaptureMetadata,
	type MailboxCaptureMetadataItem,
} from "../coordinator/contracts";
import { validateBoundedMailboxInventory } from "../coordinator/inventory";
import {
	canonicalMailboxValue,
	sha256Hex,
} from "../coordinator/hash";
import { isValidMailboxScopedAlias } from "../privacy";

export type MailboxScopedFingerprintInput = Readonly<{
	inventory: MailboxInventory;
	metadata: MailboxCaptureMetadata;
	actions: readonly (MailboxAction | MailboxCanonicalAction)[];
	targets: MailboxRevisionTargets;
}>;

const INPUT_KEYS = [
	"inventory",
	"metadata",
	"actions",
	"targets",
] as const;
const INVENTORY_KEYS = [
	"schemaVersion",
	"providerId",
	"surface",
	"accountAlias",
	"runAlias",
	"capturedAt",
	"partial",
	"messages",
	"folders",
	"labels",
	"filters",
] as const;

function reject(reason: string): never {
	throw new Error(`Mailbox fingerprint rejected ${reason}`);
}

function exactKeys(
	value: object,
	expected: readonly string[],
	reason: string,
): void {
	const keys = Object.keys(value);
	if (
		keys.length !== expected.length ||
		expected.some((key) => !Object.hasOwn(value, key)) ||
		keys.some((key) => !expected.includes(key))
	) {
		reject(reason);
	}
}

function preflightInput(
	value: unknown,
): asserts value is MailboxScopedFingerprintInput {
	preflightMailboxValue(value, {
		maxNodes: 80_000,
		maxKeys: 80_000,
		maxArrayLength: MAILBOX_CAPTURE_LIMITS.assembledInventoryItems,
		maxTotalStringLength: 2_000_000,
		maxTotalBytes: 4_000_000,
	});
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		reject("input");
	}
	exactKeys(value, INPUT_KEYS, "input");
	const input = value as Record<string, unknown>;
	if (
		!Array.isArray(input.actions) ||
		input.actions.length >
			MAILBOX_CAPTURE_LIMITS.assembledInventoryItems
	) {
		reject("actions");
	}
}

function validateTargets(value: MailboxRevisionTargets): MailboxRevisionTargets {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		reject("targets");
	}
	exactKeys(
		value,
		["folderAliases", "labelAliases", "filterAliases"],
		"targets",
	);
	const groups = [
		[value.folderAliases, "fld", MAILBOX_CAPTURE_LIMITS.folders],
		[
			value.labelAliases,
			"lbl",
			MAILBOX_CAPTURE_LIMITS.labels +
				MAILBOX_CAPTURE_LIMITS.tags +
				MAILBOX_CAPTURE_LIMITS.categories,
		],
		[value.filterAliases, "flt", MAILBOX_CAPTURE_LIMITS.filters],
	] as const;
	for (const [aliases, prefix, maximum] of groups) {
		if (
			!Array.isArray(aliases) ||
			aliases.length > maximum ||
			new Set(aliases).size !== aliases.length ||
			aliases.some((alias) => !isValidMailboxScopedAlias(alias, prefix))
		) {
			reject("targets");
		}
	}
	return value;
}

function validateMetadata(
	value: MailboxCaptureMetadata,
): MailboxCaptureMetadata {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		reject("metadata");
	}
	exactKeys(value, ["tags", "categories"], "metadata");
	if (
		!Array.isArray(value.tags) ||
		value.tags.length > MAILBOX_CAPTURE_LIMITS.tags ||
		!Array.isArray(value.categories) ||
		value.categories.length > MAILBOX_CAPTURE_LIMITS.categories
	) {
		reject("metadata");
	}
	const aliases = new Set<string>();
	const validateItems = (
		items: readonly MailboxCaptureMetadataItem[],
	): readonly MailboxCaptureMetadataItem[] =>
		items.map((item) => {
			if (
				item === null ||
				typeof item !== "object" ||
				Array.isArray(item)
			) {
				reject("metadata");
			}
			const keys = Object.keys(item);
			if (
				!Object.hasOwn(item, "alias") ||
				keys.some(
					(key) =>
						key !== "alias" && key !== "messageCount",
				) ||
				!isValidMailboxScopedAlias(item.alias, "lbl") ||
				aliases.has(item.alias) ||
				(item.messageCount !== undefined &&
					(!Number.isSafeInteger(item.messageCount) ||
						item.messageCount < 0))
			) {
				reject("metadata");
			}
			aliases.add(item.alias);
			return Object.freeze({
				alias: item.alias,
				...(item.messageCount === undefined
					? {}
					: { messageCount: item.messageCount }),
			});
		});
	return Object.freeze({
		tags: Object.freeze(validateItems(value.tags)),
		categories: Object.freeze(validateItems(value.categories)),
	});
}

function inventoryScope(value: MailboxInventory): MailboxInventory {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		reject("inventory");
	}
	exactKeys(value, INVENTORY_KEYS, "inventory");
	const collections = [
		[value.messages, MAILBOX_CAPTURE_LIMITS.messages],
		[value.folders, MAILBOX_CAPTURE_LIMITS.folders],
		[value.labels, MAILBOX_CAPTURE_LIMITS.labels],
		[value.filters, MAILBOX_CAPTURE_LIMITS.filters],
	] as const;
	if (
		collections.some(
			([items, maximum]) =>
				!Array.isArray(items) || items.length > maximum,
		)
	) {
		reject("inventory");
	}
	return validateBoundedMailboxInventory({
		schemaVersion: value.schemaVersion,
		providerId: value.providerId,
		surface: value.surface,
		accountAlias: value.accountAlias,
		runAlias: value.runAlias,
		capturedAt: value.capturedAt,
		partial: value.partial,
		messages: [],
		folders: [],
		labels: [],
		filters: [],
	});
}

type AliasSets = Readonly<{
	messages: ReadonlySet<string>;
	folders: ReadonlySet<string>;
	labels: ReadonlySet<string>;
	filters: ReadonlySet<string>;
}>;

function snapshotReferenced<Item extends Readonly<{ alias: string }>>(
	item: Item,
): Item {
	preflightMailboxValue(item, {
		maxDepth: 2,
		maxNodes: 16,
		maxKeys: 16,
		maxArrayLength: 1,
		maxTotalStringLength: 1_024,
		maxTotalBytes: 4_096,
	});
	return Object.freeze(structuredClone(item));
}

function selectReferenced<Item extends Readonly<{ alias: string }>>(
	collections: readonly (readonly Item[])[],
	requested: ReadonlySet<string>,
): readonly Item[] {
	const found = new Set<string>();
	const selected: Item[] = [];
	for (const items of collections) {
		for (const item of items) {
			const descriptor = Object.getOwnPropertyDescriptor(item, "alias");
			if (
				descriptor === undefined ||
				"get" in descriptor ||
				"set" in descriptor ||
				typeof descriptor.value !== "string"
			) {
				reject("inventory");
			}
			const alias = descriptor.value;
			if (requested.has(alias)) {
				if (found.has(alias)) reject("broken reference");
				found.add(alias);
				selected.push(snapshotReferenced(item));
			}
		}
	}
	if (found.size !== requested.size) reject("broken reference");
	selected.sort((left, right) => left.alias.localeCompare(right.alias));
	return selected;
}

type ReferencedLabelLike = Readonly<{
	labels: readonly MailboxInventory["labels"][number][];
	tags: readonly MailboxCaptureMetadataItem[];
	categories: readonly MailboxCaptureMetadataItem[];
}>;

function selectReferencedLabelLike(
	labels: readonly MailboxInventory["labels"][number][],
	tags: readonly MailboxCaptureMetadataItem[],
	categories: readonly MailboxCaptureMetadataItem[],
	requested: ReadonlySet<string>,
): ReferencedLabelLike {
	const found = new Set<string>();
	const selected: {
		labels: MailboxInventory["labels"][number][];
		tags: MailboxCaptureMetadataItem[];
		categories: MailboxCaptureMetadataItem[];
	} = {
		labels: [],
		tags: [],
		categories: [],
	};
	const scan = <Item extends Readonly<{ alias: string }>>(
		items: readonly Item[],
		output: Item[],
	): void => {
		for (const item of items) {
			const descriptor = Object.getOwnPropertyDescriptor(item, "alias");
			if (
				descriptor === undefined ||
				"get" in descriptor ||
				"set" in descriptor ||
				typeof descriptor.value !== "string"
			) {
				reject("inventory");
			}
			const alias = descriptor.value;
			if (requested.has(alias)) {
				if (found.has(alias)) reject("broken reference");
				found.add(alias);
				output.push(snapshotReferenced(item));
			}
		}
	};
	scan(labels, selected.labels);
	scan(tags, selected.tags);
	scan(categories, selected.categories);
	if (found.size !== requested.size) reject("broken reference");
	const sort = <Item extends Readonly<{ alias: string }>>(
		items: Item[],
	): readonly Item[] =>
		items.sort((left, right) => left.alias.localeCompare(right.alias));
	return Object.freeze({
		labels: sort(selected.labels),
		tags: sort(selected.tags),
		categories: sort(selected.categories),
	});
}

export async function computeMailboxScopedFingerprint(
	value: MailboxScopedFingerprintInput,
	signal?: AbortSignal,
): Promise<MailboxFingerprint> {
	if (signal !== undefined) throwIfMailboxAborted(signal);
	preflightInput(value);
	const scope = inventoryScope(value.inventory);
	const metadata = validateMetadata(value.metadata);
	const actions = value.actions.map(
		(action): MailboxAction | MailboxCanonicalAction =>
			action !== null &&
			typeof action === "object" &&
			Object.hasOwn(action, "actionAlias")
				? validateCanonicalMailboxAction(action)
				: validateMailboxAction(action),
	);
	const targets = validateTargets(value.targets);
	const desiredFolders = new Set<string>();
	const desiredLabels = new Set<string>();
	const desiredFilters = new Set<string>();
	for (const action of actions) {
		if (action.type === "create_folder") {
			desiredFolders.add(action.folderAlias);
		}
		if (action.type === "rename_folder") {
			desiredFolders.add(action.replacementFolderAlias);
		}
		if (
			action.type === "create_label" ||
			action.type === "create_category"
		) {
			desiredLabels.add(action.labelAlias);
		}
		if (
			action.type === "rename_label" ||
			action.type === "rename_category"
		) {
			desiredLabels.add(action.replacementLabelAlias);
		}
		if (action.type === "create_filter") {
			desiredFilters.add(action.filterAlias);
		}
		if (action.type === "change_filter") {
			desiredFilters.add(action.replacementFilterAlias);
		}
	}
	const aliases: {
		messages: Set<string>;
		folders: Set<string>;
		labels: Set<string>;
		filters: Set<string>;
	} = {
		messages: new Set(),
		folders: new Set(
			targets.folderAliases.filter(
				(alias) => !desiredFolders.has(alias),
			),
		),
		labels: new Set(
			targets.labelAliases.filter(
				(alias) => !desiredLabels.has(alias),
			),
		),
		filters: new Set(
			targets.filterAliases.filter(
				(alias) => !desiredFilters.has(alias),
			),
		),
	};
	for (const action of actions) {
		if ("messageAlias" in action) aliases.messages.add(action.messageAlias);
		if (
			"folderAlias" in action &&
			!desiredFolders.has(action.folderAlias)
		) {
			aliases.folders.add(action.folderAlias);
		}
		if (
			"labelAlias" in action &&
			!desiredLabels.has(action.labelAlias)
		) {
			aliases.labels.add(action.labelAlias);
		}
		if (
			"filterAlias" in action &&
			!desiredFilters.has(action.filterAlias)
		) {
			aliases.filters.add(action.filterAlias);
		}
	}
	const collections = {
		messages: Object.freeze([...value.inventory.messages]),
		folders: Object.freeze([...value.inventory.folders]),
		labels: Object.freeze([...value.inventory.labels]),
		filters: Object.freeze([...value.inventory.filters]),
	};
	const messages = selectReferenced(
		[collections.messages],
		aliases.messages,
	);
	const folders = selectReferenced(
		[collections.folders],
		aliases.folders,
	);
	const labelLike = selectReferencedLabelLike(
		collections.labels,
		metadata.tags,
		metadata.categories,
		aliases.labels,
	);
	const filters = selectReferenced(
		[collections.filters],
		aliases.filters,
	);
	const referenced = validateBoundedMailboxInventory({
		...scope,
		messages,
		folders,
		labels: labelLike.labels,
		filters,
	});
	const canonical = canonicalMailboxValue({
		schemaVersion: 1,
		providerId: scope.providerId,
		surface: scope.surface,
		accountAlias: scope.accountAlias,
		messages: referenced.messages,
		folders: referenced.folders,
		labels: referenced.labels,
		tags: labelLike.tags,
		categories: labelLike.categories,
		filters: referenced.filters,
	});
	if (signal !== undefined) {
		await yieldMailboxTask(signal);
		await yieldMailboxTask(signal);
	}
	return validateMailboxFingerprint({
		schemaVersion: 1,
		algorithm: "sha256",
		digest: await sha256Hex(canonical),
	});
}

export function mailboxFingerprintsMatch(
	left: MailboxFingerprint,
	right: MailboxFingerprint,
): boolean {
	return (
		validateMailboxFingerprint(left).digest ===
		validateMailboxFingerprint(right).digest
	);
}
