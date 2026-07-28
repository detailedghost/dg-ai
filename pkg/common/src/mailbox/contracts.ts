import { failMailboxBoundary } from "./errors";
import { preflightMailboxValue } from "./preflight";

export const MAILBOX_SCHEMA_VERSION = 1 as const;

export const MAILBOX_MESSAGE_CATEGORIES = [
	"transactional",
	"newsletter",
	"notification",
	"social",
	"promotional",
	"personal",
	"other",
] as const;

export type MailboxMessageCategory =
	(typeof MAILBOX_MESSAGE_CATEGORIES)[number];

export type MailboxMessage = Readonly<{
	alias: string;
	read: boolean;
	hasAttachments: boolean;
	receivedAt: string;
	category: MailboxMessageCategory;
}>;

export type MailboxFolder = Readonly<{
	alias: string;
	messageCount?: number;
}>;

export type MailboxLabel = Readonly<{
	alias: string;
	messageCount?: number;
}>;

export type MailboxFilter = Readonly<{
	alias: string;
	active: boolean;
}>;

export type MailboxInventory = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	providerId: string;
	surface: string;
	accountAlias: string;
	runAlias: string;
	capturedAt: string;
	partial: boolean;
	messages: readonly MailboxMessage[];
	folders: readonly MailboxFolder[];
	labels: readonly MailboxLabel[];
	filters: readonly MailboxFilter[];
}>;

export const MAILBOX_ACTION_TYPES = [
	"archive",
	"mark_read",
	"move_to_folder",
	"apply_label",
	"remove_label",
	"deactivate_filter",
] as const;

export type MailboxActionType = (typeof MAILBOX_ACTION_TYPES)[number];

export const MAILBOX_EXECUTION_ACTION_TYPES = [
	"archive",
	"move_to_folder",
	"mark_read",
	"create_folder",
	"rename_folder",
	"create_label",
	"rename_label",
	"apply_label",
	"create_category",
	"rename_category",
	"apply_category",
	"create_filter",
	"change_filter",
	"deactivate_filter",
] as const;

export type MailboxExecutionActionType =
	(typeof MAILBOX_EXECUTION_ACTION_TYPES)[number];

export type MailboxAction =
	| Readonly<{ type: "archive"; messageAlias: string }>
	| Readonly<{ type: "mark_read"; messageAlias: string }>
	| Readonly<{
			type: "move_to_folder";
			messageAlias: string;
			folderAlias: string;
	  }>
	| Readonly<{
			type: "apply_label";
			messageAlias: string;
			labelAlias: string;
	  }>
	| Readonly<{
			type: "remove_label";
			messageAlias: string;
			labelAlias: string;
	  }>
	| Readonly<{ type: "deactivate_filter"; filterAlias: string }>;

export type MailboxExecutionActionPayload =
	| Exclude<MailboxAction, Readonly<{
			type: "remove_label";
			messageAlias: string;
			labelAlias: string;
	  }>>
	| Readonly<{ type: "create_folder"; folderAlias: string }>
	| Readonly<{
			type: "rename_folder";
			folderAlias: string;
			replacementFolderAlias: string;
	  }>
	| Readonly<{ type: "create_label"; labelAlias: string }>
	| Readonly<{
			type: "rename_label";
			labelAlias: string;
			replacementLabelAlias: string;
	  }>
	| Readonly<{
			type: "apply_label";
			messageAlias: string;
			labelAlias: string;
	  }>
	| Readonly<{ type: "create_category"; labelAlias: string }>
	| Readonly<{
			type: "rename_category";
			labelAlias: string;
			replacementLabelAlias: string;
	  }>
	| Readonly<{
			type: "apply_category";
			messageAlias: string;
			labelAlias: string;
	  }>
	| Readonly<{ type: "create_filter"; filterAlias: string }>
	| Readonly<{
			type: "change_filter";
			filterAlias: string;
			replacementFilterAlias: string;
	  }>
	| Readonly<{ type: "deactivate_filter"; filterAlias: string }>;

export type MailboxCanonicalActionMetadata = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	actionAlias: string;
	dependsOn?: readonly string[];
}>;

export type MailboxCanonicalAction =
	MailboxExecutionActionPayload & MailboxCanonicalActionMetadata;

export const MAILBOX_AGE_BUCKETS = [
	"recent",
	"older",
	"old",
] as const;

export type MailboxAgeBucket = (typeof MAILBOX_AGE_BUCKETS)[number];

export type MailboxCohort = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	cohortKey: string;
	category: MailboxMessageCategory;
	ageBucket: MailboxAgeBucket;
	messageAliases: readonly string[];
	suggestedActions: readonly MailboxAction[];
}>;

export type MailboxFingerprint = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	algorithm: "sha256";
	digest: string;
}>;

export const MAILBOX_REVISION_STATES = [
	"draft",
	"approved",
	"in_flight",
	"completed",
	"canceled",
] as const;

export type MailboxRevisionState =
	(typeof MAILBOX_REVISION_STATES)[number];

type MailboxPlanRevisionBase = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	planAlias: string;
	revisionAlias: string;
	revisionNumber: number;
	restartRequired: boolean;
	createdAt: string;
	inventoryFingerprint: MailboxFingerprint;
	cohorts: readonly MailboxCohort[];
	targets: MailboxRevisionTargets;
}>;

export type MailboxPlanRevision = MailboxPlanRevisionBase &
	Readonly<{
		state: MailboxRevisionState;
		actions: readonly MailboxAction[];
	}>;

export type MailboxCanonicalPlanRevision = MailboxPlanRevisionBase &
	Readonly<{
		state: Exclude<MailboxRevisionState, "draft">;
		actions: readonly MailboxCanonicalAction[];
	}>;

export type MailboxPersistedPlanRevision =
	| MailboxPlanRevision
	| MailboxCanonicalPlanRevision;

export type MailboxRevision = MailboxPlanRevision;

export type MailboxRevisionTargets = Readonly<{
	folderAliases: readonly string[];
	labelAliases: readonly string[];
	filterAliases: readonly string[];
}>;

export const MAILBOX_OBSERVATION_CODES = [
	"matched",
	"changed",
	"unchanged",
	"verified",
	"verification_mismatch",
] as const;

export type MailboxObservationCode =
	(typeof MAILBOX_OBSERVATION_CODES)[number];

export type MailboxObservation = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	code: MailboxObservationCode;
	aliases: readonly string[];
	count: number;
	observedAt: string;
}>;

/** Provider-facing name retained to make the frozen extension point explicit. */
export type MailboxProviderObservation = MailboxObservation;

export const MAILBOX_RESULT_STATUSES = [
	"completed",
	"skipped",
	"needs_review",
	"failed",
] as const;

export type MailboxResultStatus =
	(typeof MAILBOX_RESULT_STATUSES)[number];

export const MAILBOX_REASON_CODES = [
	"already_applied",
	"not_found",
	"stale_binding",
	"wrong_account",
	"unsupported_locale",
	"layout_mismatch",
	"blocked_prompt",
	"provider_partial",
	"verification_mismatch",
	"canceled",
	"worker_suspended",
	"provider_timeout",
	"provider_refused",
	"malformed_stream",
	"internal_failure",
] as const;

export type MailboxReasonCode = (typeof MAILBOX_REASON_CODES)[number];

export type MailboxActionResult = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	action: MailboxAction;
	status: MailboxResultStatus;
	reasonCode?: MailboxReasonCode;
	affectedCount: number;
	observations: readonly MailboxObservation[];
}>;

export type MailboxError = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	code: MailboxReasonCode;
	retryable: boolean;
	relatedAlias?: string;
}>;

export const MAILBOX_HINT_CLASSIFICATIONS = [
	"archive_candidate",
	"mark_read_candidate",
	"move_candidate",
	"label_candidate",
	"deactivate_filter_candidate",
	"needs_review",
] as const;

export type MailboxHintClassification =
	(typeof MAILBOX_HINT_CLASSIFICATIONS)[number];

export type MailboxHintProvenance = Readonly<{
	source: "core_rules" | "validated_local";
	validatedAt: string;
}>;

export type MailboxHint = Readonly<{
	cohortKey: string;
	classification: MailboxHintClassification;
	confidence: number;
}>;

/**
 * Host-owned display data. Inference adapters can only return MailboxHint;
 * provenance is attached after their output crosses the untrusted boundary.
 */
export type MailboxValidatedHint = MailboxHint &
	Readonly<{ provenance: MailboxHintProvenance }>;

export type MailboxInferenceOutput = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	hints: readonly MailboxHint[];
}>;

export type MailboxDebriefCounts = Readonly<{
	completed: number;
	skipped: number;
	needsReview: number;
	failed: number;
}>;

export type MailboxDebrief = Readonly<{
	schemaVersion: typeof MAILBOX_SCHEMA_VERSION;
	planAlias: string;
	revisionAlias: string;
	generatedAt: string;
	counts: MailboxDebriefCounts;
	results: readonly MailboxActionResult[];
}>;

type PlainRecord = Record<string, unknown>;

const IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE = /^[a-z][a-z0-9_-]{0,63}$/;
const COHORT_KEY = /^[a-z0-9][a-z0-9-]{0,127}$/;
const ALIAS_PREFIXES = [
	"acct",
	"run",
	"rev",
	"msg",
	"fld",
	"lbl",
	"flt",
	"act",
	"coh",
	"plan",
] as const;
const ALIAS = /^(acct|run|rev|msg|fld|lbl|flt|act|coh|plan)_([a-f0-9]{32})$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const MAX_INVENTORY_ITEMS = Object.freeze({
	messages: 5_000,
	folders: 500,
	labels: 1_000,
	filters: 500,
});
// Nodes: root + seven scalar values + four arrays, then each item and value.
// Keys: eleven root keys + four array lengths, then each index and item key.
const INVENTORY_PREFLIGHT_LIMITS = Object.freeze({
	maxNodes:
		12 +
		MAX_INVENTORY_ITEMS.messages * 6 +
		MAX_INVENTORY_ITEMS.folders * 3 +
		MAX_INVENTORY_ITEMS.labels * 3 +
		MAX_INVENTORY_ITEMS.filters * 3,
	maxKeys:
		15 +
		MAX_INVENTORY_ITEMS.messages * 6 +
		MAX_INVENTORY_ITEMS.folders * 3 +
		MAX_INVENTORY_ITEMS.labels * 3 +
		MAX_INVENTORY_ITEMS.filters * 3,
});

function record(value: unknown): PlainRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		failMailboxBoundary("invalid_type");
	}
	return value as PlainRecord;
}

function exactKeys(
	value: PlainRecord,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) failMailboxBoundary("unknown_key");
	}
	for (const key of required) {
		if (!Object.hasOwn(value, key)) failMailboxBoundary("missing_key");
	}
}

function literal<T extends string>(
	value: unknown,
	values: readonly T[],
): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		failMailboxBoundary("invalid_value");
	}
	return value as T;
}

function stringMatching(value: unknown, expression: RegExp): string {
	if (typeof value !== "string" || !expression.test(value)) {
		failMailboxBoundary("invalid_value");
	}
	return value;
}

function boolean(value: unknown): boolean {
	if (typeof value !== "boolean") failMailboxBoundary("invalid_type");
	return value;
}

function finiteNumber(value: unknown): number {
	if (typeof value !== "number") failMailboxBoundary("invalid_type");
	if (!Number.isFinite(value)) failMailboxBoundary("non_finite_number");
	return value;
}

function count(value: unknown): number {
	const parsed = finiteNumber(value);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		failMailboxBoundary("invalid_value");
	}
	return parsed;
}

function positiveInteger(value: unknown): number {
	const parsed = count(value);
	if (parsed < 1) failMailboxBoundary("invalid_value");
	return parsed;
}

function timestamp(value: unknown): string {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
	) {
		failMailboxBoundary("invalid_timestamp");
	}
	const milliseconds = Date.parse(value);
	if (
		!Number.isFinite(milliseconds) ||
		new Date(milliseconds).toISOString() !== value
	) {
		failMailboxBoundary("invalid_timestamp");
	}
	return value;
}

function schemaVersion(value: unknown): 1 {
	if (value !== MAILBOX_SCHEMA_VERSION) {
		failMailboxBoundary("unsupported_schema");
	}
	return MAILBOX_SCHEMA_VERSION;
}

function alias(value: unknown, prefix?: string): string {
	const match = typeof value === "string" ? ALIAS.exec(value) : null;
	if (
		match === null ||
		(prefix !== undefined && match[1] !== prefix) ||
		!ALIAS_PREFIXES.includes(
			match[1] as (typeof ALIAS_PREFIXES)[number],
		) ||
		!hasOpaquePayload(match[2] as string)
	) {
		failMailboxBoundary("invalid_alias");
	}
	return value as string;
}

function hasOpaquePayload(payload: string): boolean {
	if (new Set(payload).size < 8) return false;
	const bytes = payload.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16));
	if (bytes === undefined || bytes.length !== 16) return false;
	const meaningful = bytes.filter((byte) => byte !== 0);
	return !(
		meaningful.length >= 4 &&
		meaningful.every((byte) => byte >= 0x20 && byte <= 0x7e)
	);
}

function array<T>(
	value: unknown,
	validate: (item: unknown) => T,
	max = 10_000,
): readonly T[] {
	if (!Array.isArray(value)) failMailboxBoundary("invalid_type");
	if (value.length > max) failMailboxBoundary("size_limit");
	return value.map(validate);
}

function unique(values: readonly string[]): void {
	if (new Set(values).size !== values.length) {
		failMailboxBoundary("duplicate_alias");
	}
}

function parseMessage(value: unknown): MailboxMessage {
	const input = record(value);
	exactKeys(input, [
		"alias",
		"read",
		"hasAttachments",
		"receivedAt",
		"category",
	]);
	return {
		alias: alias(input.alias, "msg"),
		read: boolean(input.read),
		hasAttachments: boolean(input.hasAttachments),
		receivedAt: timestamp(input.receivedAt),
		category: literal(input.category, MAILBOX_MESSAGE_CATEGORIES),
	};
}

function parseFolder(value: unknown): MailboxFolder {
	const input = record(value);
	exactKeys(input, ["alias"], ["messageCount"]);
	return {
		alias: alias(input.alias, "fld"),
		...(input.messageCount === undefined
			? {}
			: { messageCount: count(input.messageCount) }),
	};
}

function parseLabel(value: unknown): MailboxLabel {
	const input = record(value);
	exactKeys(input, ["alias"], ["messageCount"]);
	return {
		alias: alias(input.alias, "lbl"),
		...(input.messageCount === undefined
			? {}
			: { messageCount: count(input.messageCount) }),
	};
}

function parseFilter(value: unknown): MailboxFilter {
	const input = record(value);
	exactKeys(input, ["alias", "active"]);
	return {
		alias: alias(input.alias, "flt"),
		active: boolean(input.active),
	};
}

function parseInventory(value: unknown): MailboxInventory {
	const input = record(value);
	exactKeys(input, [
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
	]);
	const messages = array(
		input.messages,
		parseMessage,
		MAX_INVENTORY_ITEMS.messages,
	);
	const folders = array(
		input.folders,
		parseFolder,
		MAX_INVENTORY_ITEMS.folders,
	);
	const labels = array(
		input.labels,
		parseLabel,
		MAX_INVENTORY_ITEMS.labels,
	);
	const filters = array(
		input.filters,
		parseFilter,
		MAX_INVENTORY_ITEMS.filters,
	);
	const aliases = [
		...messages.map((item) => item.alias),
		...folders.map((item) => item.alias),
		...labels.map((item) => item.alias),
		...filters.map((item) => item.alias),
	];
	unique(aliases);
	return {
		schemaVersion: schemaVersion(input.schemaVersion),
		providerId: stringMatching(input.providerId, IDENTIFIER),
		surface: stringMatching(input.surface, SURFACE),
		accountAlias: alias(input.accountAlias, "acct"),
		runAlias: alias(input.runAlias, "run"),
		capturedAt: timestamp(input.capturedAt),
		partial: boolean(input.partial),
		messages,
		folders,
		labels,
		filters,
	};
}

export function validateMailboxInventory(value: unknown): MailboxInventory {
	preflightMailboxValue(value, INVENTORY_PREFLIGHT_LIMITS);
	return parseInventory(value);
}

function parseActionMetadata(
	input: Record<string, unknown>,
	requiredKeys: readonly string[],
	requireCanonical: boolean,
): MailboxCanonicalActionMetadata | undefined {
	if (!requireCanonical) {
		exactKeys(input, requiredKeys);
		return undefined;
	}
	const hasCanonicalKey =
		Object.hasOwn(input, "schemaVersion") ||
		Object.hasOwn(input, "actionAlias") ||
		Object.hasOwn(input, "dependsOn");
	if (hasCanonicalKey) {
		exactKeys(
			input,
			[...requiredKeys, "schemaVersion", "actionAlias"],
			["dependsOn"],
		);
		const actionAlias = alias(input.actionAlias, "act");
		const dependsOn =
			input.dependsOn === undefined
				? undefined
				: array(
						input.dependsOn,
						(item) => alias(item, "act"),
						10_000,
					);
		if (dependsOn !== undefined) {
			unique(dependsOn);
			if (dependsOn.includes(actionAlias)) {
				failMailboxBoundary("broken_reference");
			}
		}
		return {
			schemaVersion: schemaVersion(input.schemaVersion),
			actionAlias,
			...(dependsOn === undefined ? {} : { dependsOn }),
		};
	}
	failMailboxBoundary("missing_key");
}

function actionWithMetadata(
	action: Readonly<{ type: string }> & Readonly<Record<string, unknown>>,
	metadata: MailboxCanonicalActionMetadata | undefined,
): MailboxAction | MailboxCanonicalAction {
	return (metadata === undefined
		? action
		: { ...metadata, ...action }) as MailboxAction | MailboxCanonicalAction;
}

function parseAction(value: unknown, requireCanonical: true): MailboxCanonicalAction;
function parseAction(value: unknown, requireCanonical?: false): MailboxAction;
function parseAction(
	value: unknown,
	requireCanonical = false,
): MailboxAction | MailboxCanonicalAction {
	const input = record(value);
	if (!Object.hasOwn(input, "type")) failMailboxBoundary("missing_key");
	if (typeof input.type !== "string") failMailboxBoundary("invalid_type");
	switch (input.type) {
		case "archive":
		case "mark_read": {
			const metadata = parseActionMetadata(
				input,
				["type", "messageAlias"],
				requireCanonical,
			);
			return actionWithMetadata({
				type: input.type,
				messageAlias: alias(input.messageAlias, "msg"),
			}, metadata);
		}
		case "move_to_folder": {
			const metadata = parseActionMetadata(
				input,
				["type", "messageAlias", "folderAlias"],
				requireCanonical,
			);
			return actionWithMetadata({
				type: input.type,
				messageAlias: alias(input.messageAlias, "msg"),
				folderAlias: alias(input.folderAlias, "fld"),
			}, metadata);
		}
		case "create_folder": {
			if (!requireCanonical) failMailboxBoundary("unsupported_action");
			const metadata = parseActionMetadata(
				input,
				["type", "folderAlias"],
				requireCanonical,
			);
			return actionWithMetadata({
				type: input.type,
				folderAlias: alias(input.folderAlias, "fld"),
			}, metadata);
		}
		case "rename_folder": {
			if (!requireCanonical) failMailboxBoundary("unsupported_action");
			const metadata = parseActionMetadata(
				input,
				["type", "folderAlias", "replacementFolderAlias"],
				requireCanonical,
			);
			const folderAlias = alias(input.folderAlias, "fld");
			const replacementFolderAlias = alias(
				input.replacementFolderAlias,
				"fld",
			);
			if (folderAlias === replacementFolderAlias) {
				failMailboxBoundary("invalid_value");
			}
			return actionWithMetadata({
				type: input.type,
				folderAlias,
				replacementFolderAlias,
			}, metadata);
		}
		case "create_label":
		case "create_category": {
			if (!requireCanonical) failMailboxBoundary("unsupported_action");
			const metadata = parseActionMetadata(
				input,
				["type", "labelAlias"],
				requireCanonical,
			);
			return actionWithMetadata({
				type: input.type,
				labelAlias: alias(input.labelAlias, "lbl"),
			}, metadata);
		}
		case "rename_label":
		case "rename_category": {
			if (!requireCanonical) failMailboxBoundary("unsupported_action");
			const metadata = parseActionMetadata(
				input,
				["type", "labelAlias", "replacementLabelAlias"],
				requireCanonical,
			);
			const labelAlias = alias(input.labelAlias, "lbl");
			const replacementLabelAlias = alias(
				input.replacementLabelAlias,
				"lbl",
			);
			if (labelAlias === replacementLabelAlias) {
				failMailboxBoundary("invalid_value");
			}
			return actionWithMetadata({
				type: input.type,
				labelAlias,
				replacementLabelAlias,
			}, metadata);
		}
		case "apply_label": {
			const metadata = parseActionMetadata(
				input,
				["type", "messageAlias", "labelAlias"],
				requireCanonical,
			);
			return actionWithMetadata({
				type: input.type,
				messageAlias: alias(input.messageAlias, "msg"),
				labelAlias: alias(input.labelAlias, "lbl"),
			}, metadata);
		}
		case "remove_label": {
			if (requireCanonical) {
				failMailboxBoundary("unsupported_action");
			}
			const metadata = parseActionMetadata(
				input,
				["type", "messageAlias", "labelAlias"],
				false,
			);
			return actionWithMetadata({
				type: input.type,
				messageAlias: alias(input.messageAlias, "msg"),
				labelAlias: alias(input.labelAlias, "lbl"),
			}, metadata);
		}
		case "apply_category": {
			if (!requireCanonical) failMailboxBoundary("unsupported_action");
			const metadata = parseActionMetadata(
				input,
				["type", "messageAlias", "labelAlias"],
				requireCanonical,
			);
			return actionWithMetadata({
				type: input.type,
				messageAlias: alias(input.messageAlias, "msg"),
				labelAlias: alias(input.labelAlias, "lbl"),
			}, metadata);
		}
		case "create_filter": {
			if (!requireCanonical) failMailboxBoundary("unsupported_action");
			const metadata = parseActionMetadata(
				input,
				["type", "filterAlias"],
				requireCanonical,
			);
			return actionWithMetadata({
				type: input.type,
				filterAlias: alias(input.filterAlias, "flt"),
			}, metadata);
		}
		case "deactivate_filter": {
			const metadata = parseActionMetadata(
				input,
				["type", "filterAlias"],
				requireCanonical,
			);
			return actionWithMetadata({
				type: input.type,
				filterAlias: alias(input.filterAlias, "flt"),
			}, metadata);
		}
		case "change_filter": {
			if (!requireCanonical) failMailboxBoundary("unsupported_action");
			const metadata = parseActionMetadata(
				input,
				["type", "filterAlias", "replacementFilterAlias"],
				requireCanonical,
			);
			const filterAlias = alias(input.filterAlias, "flt");
			const replacementFilterAlias = alias(
				input.replacementFilterAlias,
				"flt",
			);
			if (filterAlias === replacementFilterAlias) {
				failMailboxBoundary("invalid_value");
			}
			return actionWithMetadata({
				type: input.type,
				filterAlias,
				replacementFilterAlias,
			}, metadata);
		}
		default:
			failMailboxBoundary("unsupported_action");
	}
}

export function validateMailboxAction(value: unknown): MailboxAction {
	preflightMailboxValue(value);
	return parseAction(value);
}

export function validateCanonicalMailboxAction(
	value: unknown,
): MailboxCanonicalAction {
	preflightMailboxValue(value);
	return parseAction(value, true);
}

function canonicalActionKey(action: MailboxCanonicalAction): string {
	switch (action.type) {
		case "archive":
		case "mark_read":
			return `${action.type}:${action.messageAlias}`;
		case "move_to_folder":
			return `${action.type}:${action.messageAlias}:${action.folderAlias}`;
		case "create_folder":
			return `${action.type}:${action.folderAlias}`;
		case "rename_folder":
			return `${action.type}:${action.folderAlias}:${action.replacementFolderAlias}`;
		case "create_label":
		case "create_category":
			return `${action.type}:${action.labelAlias}`;
		case "rename_label":
		case "rename_category":
			return `${action.type}:${action.labelAlias}:${action.replacementLabelAlias}`;
		case "apply_label":
		case "apply_category":
			return `${action.type}:${action.messageAlias}:${action.labelAlias}`;
		case "create_filter":
		case "deactivate_filter":
			return `${action.type}:${action.filterAlias}`;
		case "change_filter":
			return `${action.type}:${action.filterAlias}:${action.replacementFilterAlias}`;
	}
}

export function validateCanonicalMailboxActions(
	value: unknown,
): readonly MailboxCanonicalAction[] {
	preflightMailboxValue(value);
	const actions = array(
		value,
		(item) => parseAction(item, true),
		20_000,
	);
	const aliases = actions.map((action) => action.actionAlias);
	unique(aliases);
	const keys = actions.map(canonicalActionKey);
	if (new Set(keys).size !== keys.length) {
		failMailboxBoundary("duplicate_alias");
	}
	const available = new Set(aliases);
	const dependencies = new Map(
		actions.map((action) => [
			action.actionAlias,
			action.dependsOn ?? [],
		]),
	);
	for (const action of actions) {
		for (const dependency of action.dependsOn ?? []) {
			if (!available.has(dependency)) {
				failMailboxBoundary("broken_reference");
			}
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (actionAlias: string): void => {
		if (visiting.has(actionAlias)) {
			failMailboxBoundary("broken_reference");
		}
		if (visited.has(actionAlias)) return;
		visiting.add(actionAlias);
		for (const dependency of dependencies.get(actionAlias) ?? []) {
			visit(dependency);
		}
		visiting.delete(actionAlias);
		visited.add(actionAlias);
	};
	for (const actionAlias of aliases) visit(actionAlias);
	return actions;
}

function parseCohort(value: unknown): MailboxCohort {
	const input = record(value);
	exactKeys(input, [
		"schemaVersion",
		"cohortKey",
		"category",
		"ageBucket",
		"messageAliases",
		"suggestedActions",
	]);
	const messageAliases = array(
		input.messageAliases,
		(item) => alias(item, "msg"),
		10_000,
	);
	unique(messageAliases);
	const suggestedActions = array(
		input.suggestedActions,
		(item) => parseAction(item),
		20_000,
	);
	const suggestedActionKeys = suggestedActions.map(actionKey);
	if (new Set(suggestedActionKeys).size !== suggestedActionKeys.length) {
		failMailboxBoundary("duplicate_alias");
	}
	const members = new Set(messageAliases);
	for (const action of suggestedActions) {
		if (
			"messageAlias" in action &&
			!members.has(action.messageAlias)
		) {
			failMailboxBoundary("broken_reference");
		}
	}
	return {
		schemaVersion: schemaVersion(input.schemaVersion),
		cohortKey: stringMatching(input.cohortKey, COHORT_KEY),
		category: literal(input.category, MAILBOX_MESSAGE_CATEGORIES),
		ageBucket: literal(input.ageBucket, MAILBOX_AGE_BUCKETS),
		messageAliases,
		suggestedActions,
	};
}

export function validateMailboxCohort(value: unknown): MailboxCohort {
	preflightMailboxValue(value);
	return parseCohort(value);
}

function parseFingerprint(value: unknown): MailboxFingerprint {
	const input = record(value);
	exactKeys(input, ["schemaVersion", "algorithm", "digest"]);
	if (
		input.schemaVersion !== MAILBOX_SCHEMA_VERSION ||
		input.algorithm !== "sha256" ||
		typeof input.digest !== "string" ||
		!SHA256_DIGEST.test(input.digest)
	) {
		failMailboxBoundary("invalid_fingerprint");
	}
	return {
		schemaVersion: MAILBOX_SCHEMA_VERSION,
		algorithm: "sha256",
		digest: input.digest,
	};
}

export function validateMailboxFingerprint(
	value: unknown,
): MailboxFingerprint {
	preflightMailboxValue(value);
	return parseFingerprint(value);
}

function parseRevision(
	value: unknown,
	allowFullCanonicalActions = false,
): MailboxPersistedPlanRevision {
	const input = record(value);
	exactKeys(input, [
		"schemaVersion",
		"planAlias",
		"revisionAlias",
		"revisionNumber",
		"state",
		"restartRequired",
		"createdAt",
		"inventoryFingerprint",
		"cohorts",
		"targets",
		"actions",
	]);
	const cohorts = array(input.cohorts, parseCohort, 10_000);
	const cohortKeys = cohorts.map((cohort) => cohort.cohortKey);
	if (new Set(cohortKeys).size !== cohortKeys.length) {
		failMailboxBoundary("invalid_value");
	}
	const messageAliases = cohorts.flatMap((cohort) => cohort.messageAliases);
	unique(messageAliases);
	const targets = parseRevisionTargets(input.targets);
	const state = literal(input.state, MAILBOX_REVISION_STATES);
	if (!Array.isArray(input.actions)) {
		failMailboxBoundary("invalid_type");
	}
	const canonicalFlags = input.actions.map(
		(action) =>
			action !== null &&
			typeof action === "object" &&
			(Object.hasOwn(action, "schemaVersion") ||
				Object.hasOwn(action, "actionAlias") ||
				Object.hasOwn(action, "dependsOn")),
	);
	const hasCanonical = canonicalFlags.some(Boolean);
	if (
		hasCanonical &&
		canonicalFlags.some((canonical) => !canonical)
	) {
		failMailboxBoundary("invalid_value");
	}
	const actions: readonly (MailboxAction | MailboxCanonicalAction)[] =
		hasCanonical
			? validateCanonicalMailboxActions(input.actions)
			: array(
					input.actions,
					(item) => parseAction(item),
					20_000,
				);
	if (
		hasCanonical &&
		!allowFullCanonicalActions &&
		(actions as readonly MailboxCanonicalAction[]).some(
			(action) =>
				action.type !== "archive" &&
				action.type !== "mark_read" &&
				action.type !== "move_to_folder" &&
				action.type !== "apply_label" &&
				action.type !== "deactivate_filter",
		)
	) {
		failMailboxBoundary("unsupported_action");
	}
	if (!hasCanonical) {
		const actionKeys = (actions as readonly MailboxAction[]).map(actionKey);
		if (new Set(actionKeys).size !== actionKeys.length) {
			failMailboxBoundary("duplicate_alias");
		}
	}
	const messages = new Set(messageAliases);
	const folders = new Set(targets.folderAliases);
	const labels = new Set(targets.labelAliases);
	const filters = new Set(targets.filterAliases);
	for (const action of actions) {
		assertActionReferences(action, messages, folders, labels, filters);
	}
	for (const cohort of cohorts) {
		for (const action of cohort.suggestedActions) {
			assertActionReferences(action, messages, folders, labels, filters);
		}
	}
	return {
		schemaVersion: schemaVersion(input.schemaVersion),
		planAlias: alias(input.planAlias, "plan"),
		revisionAlias: alias(input.revisionAlias, "rev"),
		revisionNumber: positiveInteger(input.revisionNumber),
		state,
		restartRequired: boolean(input.restartRequired),
		createdAt: timestamp(input.createdAt),
		inventoryFingerprint: parseFingerprint(input.inventoryFingerprint),
		cohorts,
		targets,
		actions,
	} as MailboxPersistedPlanRevision;
}

function assertActionReferences(
	action: MailboxAction | MailboxCanonicalAction,
	messages: ReadonlySet<string>,
	folders: ReadonlySet<string>,
	labels: ReadonlySet<string>,
	filters: ReadonlySet<string>,
): void {
	if ("messageAlias" in action && !messages.has(action.messageAlias)) {
		failMailboxBoundary("broken_reference");
	}
	if ("folderAlias" in action && !folders.has(action.folderAlias)) {
		failMailboxBoundary("broken_reference");
	}
	if (
		"replacementFolderAlias" in action &&
		!folders.has(action.replacementFolderAlias)
	) {
		failMailboxBoundary("broken_reference");
	}
	if ("labelAlias" in action && !labels.has(action.labelAlias)) {
		failMailboxBoundary("broken_reference");
	}
	if (
		"replacementLabelAlias" in action &&
		!labels.has(action.replacementLabelAlias)
	) {
		failMailboxBoundary("broken_reference");
	}
	if ("filterAlias" in action && !filters.has(action.filterAlias)) {
		failMailboxBoundary("broken_reference");
	}
	if (
		"replacementFilterAlias" in action &&
		!filters.has(action.replacementFilterAlias)
	) {
		failMailboxBoundary("broken_reference");
	}
}

function parseRevisionTargets(value: unknown): MailboxRevisionTargets {
	const input = record(value);
	exactKeys(input, [
		"folderAliases",
		"labelAliases",
		"filterAliases",
	]);
	const targets: MailboxRevisionTargets = {
		folderAliases: array(
			input.folderAliases,
			(item) => alias(item, "fld"),
			10_000,
		),
		labelAliases: array(
			input.labelAliases,
			(item) => alias(item, "lbl"),
			10_000,
		),
		filterAliases: array(
			input.filterAliases,
			(item) => alias(item, "flt"),
			10_000,
		),
	};
	unique(targets.folderAliases);
	unique(targets.labelAliases);
	unique(targets.filterAliases);
	unique([
		...targets.folderAliases,
		...targets.labelAliases,
		...targets.filterAliases,
	]);
	return targets;
}

function actionKey(action: MailboxAction): string {
	switch (action.type) {
		case "archive":
		case "mark_read":
			return `${action.type}:${action.messageAlias}`;
		case "move_to_folder":
			return `${action.type}:${action.messageAlias}:${action.folderAlias}`;
		case "apply_label":
		case "remove_label":
			return `${action.type}:${action.messageAlias}:${action.labelAlias}`;
		case "deactivate_filter":
			return `${action.type}:${action.filterAlias}`;
	}
}

export function validateMailboxPlanRevision(
	value: unknown,
): MailboxPlanRevision {
	preflightMailboxValue(value);
	return parseRevision(value) as MailboxPlanRevision;
}

export const validateMailboxRevision = validateMailboxPlanRevision;

export function validatePersistedMailboxPlanRevision(
	value: unknown,
): MailboxPersistedPlanRevision {
	preflightMailboxValue(value);
	return parseRevision(value);
}

export function validateCanonicalMailboxPlanRevision(
	value: unknown,
): MailboxCanonicalPlanRevision {
	preflightMailboxValue(value);
	const revision = parseRevision(value, true);
	if (
		revision.state === "draft" ||
		revision.actions.some(
			(action) => !Object.hasOwn(action, "actionAlias"),
		)
	) {
		failMailboxBoundary("invalid_value");
	}
	return revision as MailboxCanonicalPlanRevision;
}

function parseObservation(value: unknown): MailboxObservation {
	const input = record(value);
	exactKeys(input, [
		"schemaVersion",
		"code",
		"aliases",
		"count",
		"observedAt",
	]);
	const aliases = array(input.aliases, (item) => alias(item), 10_000);
	unique(aliases);
	const parsedCount = count(input.count);
	return {
		schemaVersion: schemaVersion(input.schemaVersion),
		code: literal(input.code, MAILBOX_OBSERVATION_CODES),
		aliases,
		count: parsedCount,
		observedAt: timestamp(input.observedAt),
	};
}

export function validateMailboxObservation(
	value: unknown,
): MailboxObservation {
	preflightMailboxValue(value);
	return parseObservation(value);
}

export const validateMailboxProviderObservation =
	validateMailboxObservation;

function parseReasonCode(value: unknown): MailboxReasonCode {
	return literal(value, MAILBOX_REASON_CODES);
}

function parseActionResult(value: unknown): MailboxActionResult {
	const input = record(value);
	exactKeys(
		input,
		[
			"schemaVersion",
			"action",
			"status",
			"affectedCount",
			"observations",
		],
		["reasonCode"],
	);
	const status = literal(input.status, MAILBOX_RESULT_STATUSES);
	const reasonCode =
		input.reasonCode === undefined
			? undefined
			: parseReasonCode(input.reasonCode);
	if (status === "completed" && reasonCode !== undefined) {
		failMailboxBoundary("invalid_value");
	}
	if (status !== "completed" && reasonCode === undefined) {
		failMailboxBoundary("missing_key");
	}
	return {
		schemaVersion: schemaVersion(input.schemaVersion),
		action: parseAction(input.action),
		status,
		...(reasonCode === undefined ? {} : { reasonCode }),
		affectedCount: count(input.affectedCount),
		observations: array(input.observations, parseObservation, 10_000),
	};
}

export function validateMailboxActionResult(
	value: unknown,
): MailboxActionResult {
	preflightMailboxValue(value);
	return parseActionResult(value);
}

export const validateMailboxResult = validateMailboxActionResult;

function parseMailboxError(value: unknown): MailboxError {
	const input = record(value);
	exactKeys(
		input,
		["schemaVersion", "code", "retryable"],
		["relatedAlias"],
	);
	return {
		schemaVersion: schemaVersion(input.schemaVersion),
		code: parseReasonCode(input.code),
		retryable: boolean(input.retryable),
		...(input.relatedAlias === undefined
			? {}
			: { relatedAlias: alias(input.relatedAlias) }),
	};
}

export function validateMailboxError(value: unknown): MailboxError {
	preflightMailboxValue(value);
	return parseMailboxError(value);
}

function parseHint(value: unknown): MailboxHint {
	const input = record(value);
	exactKeys(input, ["cohortKey", "classification", "confidence"]);
	const confidence = finiteNumber(input.confidence);
	if (confidence < 0 || confidence > 1) {
		failMailboxBoundary("invalid_value");
	}
	return {
		cohortKey: stringMatching(input.cohortKey, COHORT_KEY),
		classification: literal(
			input.classification,
			MAILBOX_HINT_CLASSIFICATIONS,
		),
		confidence,
	};
}

export function validateMailboxHint(value: unknown): MailboxHint {
	preflightMailboxValue(value);
	return parseHint(value);
}

export function attachMailboxHintProvenance(
	value: unknown,
	provenance: unknown,
): MailboxValidatedHint {
	preflightMailboxValue(value);
	preflightMailboxValue(provenance);
	const hint = parseHint(value);
	const input = record(provenance);
	exactKeys(input, ["source", "validatedAt"]);
	return {
		...hint,
		provenance: {
			source: literal(input.source, ["core_rules", "validated_local"]),
			validatedAt: timestamp(input.validatedAt),
		},
	};
}

function parseInferenceOutput(value: unknown): MailboxInferenceOutput {
	const input = record(value);
	exactKeys(input, ["schemaVersion", "hints"]);
	const hints = array(input.hints, parseHint, 10_000);
	const cohortKeys = hints.map((hint) => hint.cohortKey);
	if (new Set(cohortKeys).size !== cohortKeys.length) {
		failMailboxBoundary("invalid_value");
	}
	return {
		schemaVersion: schemaVersion(input.schemaVersion),
		hints,
	};
}

export function validateMailboxInferenceOutput(
	value: unknown,
): MailboxInferenceOutput {
	preflightMailboxValue(value);
	return parseInferenceOutput(value);
}

function parseDebriefCounts(value: unknown): MailboxDebriefCounts {
	const input = record(value);
	exactKeys(input, ["completed", "skipped", "needsReview", "failed"]);
	return {
		completed: count(input.completed),
		skipped: count(input.skipped),
		needsReview: count(input.needsReview),
		failed: count(input.failed),
	};
}

function parseDebrief(value: unknown): MailboxDebrief {
	const input = record(value);
	exactKeys(input, [
		"schemaVersion",
		"planAlias",
		"revisionAlias",
		"generatedAt",
		"counts",
		"results",
	]);
	const counts = parseDebriefCounts(input.counts);
	const results = array(input.results, parseActionResult, 20_000);
	const expected: MailboxDebriefCounts = {
		completed: results.filter((item) => item.status === "completed").length,
		skipped: results.filter((item) => item.status === "skipped").length,
		needsReview: results.filter(
			(item) => item.status === "needs_review",
		).length,
		failed: results.filter((item) => item.status === "failed").length,
	};
	if (
		counts.completed !== expected.completed ||
		counts.skipped !== expected.skipped ||
		counts.needsReview !== expected.needsReview ||
		counts.failed !== expected.failed
	) {
		failMailboxBoundary("invalid_value");
	}
	return {
		schemaVersion: schemaVersion(input.schemaVersion),
		planAlias: alias(input.planAlias, "plan"),
		revisionAlias: alias(input.revisionAlias, "rev"),
		generatedAt: timestamp(input.generatedAt),
		counts,
		results,
	};
}

export function validateMailboxDebrief(value: unknown): MailboxDebrief {
	preflightMailboxValue(value);
	return parseDebrief(value);
}
