import {
	attachMailboxHintProvenance,
	preflightMailboxValue,
	validateMailboxHint,
	validateMailboxInventory,
	validateMailboxPlanRevision,
	type MailboxAction,
	type MailboxFingerprint,
	type MailboxValidatedHint,
} from "@dg/common";
import {
	MAILBOX_CAPTURE_LIMITS,
	type MailboxCaptureCounts,
	type MailboxCaptureMetadata,
} from "../coordinator";
import {
	createMailboxCleanupChoices,
	deriveMailboxCohorts,
} from "../planning";
import { isValidMailboxScopedAlias } from "../privacy";
import type {
	RawBindingScope,
	SessionStorageSeam,
} from "../storage";
import type {
	MailboxPlanWorkspaceInput,
	SuccessfulMailboxCapture,
} from "./contracts";

export const MAILBOX_PLAN_BOOTSTRAP_KEY =
	"dg:mailbox:plan-page:active:v1";

export type MailboxPlanBootstrapDeps = Readonly<{
	session: Pick<SessionStorageSeam, "get" | "delete">;
	computeFingerprint(value: {
		inventory: SuccessfulMailboxCapture["inventory"];
		metadata: SuccessfulMailboxCapture["metadata"];
		actions: readonly MailboxAction[];
		targets: MailboxPlanWorkspaceInput["baseRevision"]["targets"];
	}): Promise<MailboxFingerprint>;
}>;

export type MailboxPlanOpenDeps = Readonly<{
	session: Pick<SessionStorageSeam, "set" | "delete">;
	computeFingerprint: MailboxPlanBootstrapDeps["computeFingerprint"];
	runtime: Readonly<{ getURL(path: string): string }>;
	tabs: Readonly<{
		create(value: Readonly<{ url: string }>): Promise<unknown> | unknown;
	}>;
}>;

function invalid(): never {
	throw new Error("Invalid mailbox plan bootstrap");
}

function exact(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		invalid();
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set([...required, ...optional]);
	if (
		required.some((key) => !Object.hasOwn(record, key)) ||
		Object.keys(record).some((key) => !allowed.has(key))
	) {
		invalid();
	}
	return record;
}

function safeInteger(value: unknown): number {
	if (!Number.isSafeInteger(value)) invalid();
	return value as number;
}

function expiry(value: unknown): number {
	const timestamp = safeInteger(value);
	if (!Number.isFinite(new Date(timestamp).getTime())) invalid();
	return timestamp;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
		return value;
	}
	for (const child of Object.values(value as Record<string, unknown>)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}

function stable(value: unknown): string {
	return JSON.stringify(value);
}

function metadataItem(value: unknown): Readonly<{
	alias: string;
	messageCount?: number;
}> {
	const input = exact(value, ["alias"], ["messageCount"]);
	if (
		typeof input.alias !== "string" ||
		!isValidMailboxScopedAlias(input.alias, "lbl") ||
		(input.messageCount !== undefined &&
			(!Number.isSafeInteger(input.messageCount) ||
				(input.messageCount as number) < 0))
	) {
		invalid();
	}
	return Object.freeze({
		alias: input.alias,
		...(input.messageCount === undefined
			? {}
			: { messageCount: input.messageCount as number }),
	});
}

function metadata(value: unknown): MailboxCaptureMetadata {
	const input = exact(value, ["tags", "categories"]);
	if (!Array.isArray(input.tags) || !Array.isArray(input.categories)) {
		invalid();
	}
	if (
		input.tags.length > MAILBOX_CAPTURE_LIMITS.tags ||
		input.categories.length > MAILBOX_CAPTURE_LIMITS.categories
	) {
		invalid();
	}
	const tags = input.tags.map(metadataItem);
	const categories = input.categories.map(metadataItem);
	const aliases = [...tags, ...categories].map((item) => item.alias);
	if (new Set(aliases).size !== aliases.length) invalid();
	return Object.freeze({
		tags: Object.freeze(tags),
		categories: Object.freeze(categories),
	});
}

function counts(
	value: unknown,
	inventory: SuccessfulMailboxCapture["inventory"],
	captureMetadata: MailboxCaptureMetadata,
): MailboxCaptureCounts {
	const input = exact(value, [
		"messages",
		"folders",
		"labels",
		"tags",
		"categories",
		"filters",
	]);
	const expected = {
		messages: inventory.messages.length,
		folders: inventory.folders.length,
		labels: inventory.labels.length,
		tags: captureMetadata.tags.length,
		categories: captureMetadata.categories.length,
		filters: inventory.filters.length,
	};
	for (const [key, count] of Object.entries(expected)) {
		if (input[key] !== count) invalid();
	}
	return Object.freeze(expected);
}

function capture(value: unknown): SuccessfulMailboxCapture {
	const input = exact(
		value,
		["status", "inventory", "counts", "metadata", "cohorts", "choices"],
		["reasonCode"],
	);
	if (input.status !== "complete" && input.status !== "partial") invalid();
	let inventory;
	try {
		inventory = deepFreeze(
			validateMailboxInventory(structuredClone(input.inventory)),
		);
	} catch {
		invalid();
	}
	const captureMetadata = metadata(input.metadata);
	const captureCounts = counts(
		input.counts,
		inventory,
		captureMetadata,
	);
	const expectedPartial = input.status === "partial";
	if (
		inventory.partial !== expectedPartial ||
		(expectedPartial
			? input.reasonCode !== "provider_partial"
			: Object.hasOwn(input, "reasonCode"))
	) {
		invalid();
	}
	const expectedCohorts = deriveMailboxCohorts(inventory);
	const expectedChoices = createMailboxCleanupChoices(
		inventory,
		captureMetadata,
	);
	if (
		stable(input.cohorts) !== stable(expectedCohorts) ||
		stable(input.choices) !== stable(expectedChoices)
	) {
		invalid();
	}
	return deepFreeze({
		status: input.status,
		...(expectedPartial
			? { reasonCode: "provider_partial" as const }
			: {}),
		inventory,
		counts: captureCounts,
		metadata: captureMetadata,
		cohorts: expectedCohorts,
		choices: expectedChoices,
	});
}

function bindingScope(value: unknown): RawBindingScope {
	const input = exact(value, [
		"planAlias",
		"providerId",
		"surface",
		"accountAlias",
		"runAlias",
		"revisionAlias",
	]);
	if (
		typeof input.planAlias !== "string" ||
		!isValidMailboxScopedAlias(input.planAlias, "plan") ||
		typeof input.accountAlias !== "string" ||
		!isValidMailboxScopedAlias(input.accountAlias, "acct") ||
		typeof input.runAlias !== "string" ||
		!isValidMailboxScopedAlias(input.runAlias, "run") ||
		typeof input.revisionAlias !== "string" ||
		!isValidMailboxScopedAlias(input.revisionAlias, "rev") ||
		typeof input.providerId !== "string" ||
		!/^[a-z][a-z0-9-]{0,63}$/.test(input.providerId) ||
		typeof input.surface !== "string" ||
		!/^[a-z][a-z0-9_-]{0,63}$/.test(input.surface)
	) {
		invalid();
	}
	return Object.freeze({
		planAlias: input.planAlias,
		providerId: input.providerId,
		surface: input.surface,
		accountAlias: input.accountAlias,
		runAlias: input.runAlias,
		revisionAlias: input.revisionAlias,
	});
}

function localHint(value: unknown): MailboxValidatedHint {
	const input = exact(value, [
		"cohortKey",
		"classification",
		"confidence",
		"provenance",
	]);
	const provenance = exact(input.provenance, [
		"source",
		"validatedAt",
	]);
	let hint;
	try {
		hint = validateMailboxHint({
			cohortKey: input.cohortKey,
			classification: input.classification,
			confidence: input.confidence,
		});
		return attachMailboxHintProvenance(hint, provenance);
	} catch {
		invalid();
	}
}

function assertCrossReferences(
	input: MailboxPlanWorkspaceInput,
): void {
	const { capture: result, baseRevision, bindingScope: scope } = input;
	if (
		baseRevision.planAlias !== scope.planAlias ||
		baseRevision.revisionAlias !== scope.revisionAlias ||
		result.inventory.accountAlias !== scope.accountAlias ||
		result.inventory.runAlias !== scope.runAlias ||
		result.inventory.providerId !== scope.providerId ||
		result.inventory.surface !== scope.surface ||
		stable(baseRevision.cohorts) !== stable(result.cohorts)
	) {
		invalid();
	}
	const messages = new Set(
		result.inventory.messages.map((item) => item.alias),
	);
	const folders = new Set(
		result.inventory.folders.map((item) => item.alias),
	);
	const labels = new Set([
		...result.inventory.labels.map((item) => item.alias),
		...result.metadata.tags.map((item) => item.alias),
		...result.metadata.categories.map((item) => item.alias),
	]);
	const filters = new Set(
		result.inventory.filters.map((item) => item.alias),
	);
	const allAliases = [
		...messages,
		...folders,
		...result.inventory.labels.map((item) => item.alias),
		...result.metadata.tags.map((item) => item.alias),
		...result.metadata.categories.map((item) => item.alias),
		...filters,
	];
	if (
		new Set(allAliases).size !== allAliases.length ||
		baseRevision.targets.folderAliases.some((alias) => !folders.has(alias)) ||
		baseRevision.targets.labelAliases.some((alias) => !labels.has(alias)) ||
		baseRevision.targets.filterAliases.some((alias) => !filters.has(alias)) ||
		baseRevision.actions.some((action) => {
			if ("messageAlias" in action && !messages.has(action.messageAlias)) {
				return true;
			}
			if (action.type === "move_to_folder") {
				return !folders.has(action.folderAlias);
			}
			if (action.type === "apply_label" || action.type === "remove_label") {
				return !labels.has(action.labelAlias);
			}
			if (action.type === "deactivate_filter") {
				return !filters.has(action.filterAlias);
			}
			return false;
		}) ||
		input.localHints?.some(
			(hint) =>
				!result.cohorts.some(
					(cohort) => cohort.cohortKey === hint.cohortKey,
				),
		)
	) {
		invalid();
	}
}

export function validateMailboxPlanBootstrap(
	value: unknown,
): MailboxPlanWorkspaceInput {
	try {
		preflightMailboxValue(value, {
			maxNodes: 100_000,
			maxKeys: 100_000,
			maxArrayLength: MAILBOX_CAPTURE_LIMITS.messages,
			maxTotalStringLength: MAILBOX_CAPTURE_LIMITS.sanitizedTextCharacters,
			maxTotalBytes: MAILBOX_CAPTURE_LIMITS.sanitizedTextCharacters * 2,
		});
	} catch {
		invalid();
	}
	const root = exact(
		value,
		[
			"capture",
			"baseRevision",
			"bindingScope",
			"bindingExpiresAt",
			"planExpiresAt",
		],
		["localHints"],
	);
	let baseRevision;
	try {
		baseRevision = deepFreeze(
			validateMailboxPlanRevision(structuredClone(root.baseRevision)),
		);
	} catch {
		invalid();
	}
	if (
		root.localHints !== undefined &&
		(!Array.isArray(root.localHints) || root.localHints.length > 10_000)
	) {
		invalid();
	}
	const result = deepFreeze({
		capture: capture(root.capture),
		baseRevision,
		bindingScope: bindingScope(root.bindingScope),
		bindingExpiresAt: expiry(root.bindingExpiresAt),
		planExpiresAt: expiry(root.planExpiresAt),
		...(root.localHints === undefined
			? {}
			: {
					localHints: Object.freeze(
						(root.localHints as unknown[]).map(localHint),
					),
				}),
	}) satisfies MailboxPlanWorkspaceInput;
	const createdAt = Date.parse(result.baseRevision.createdAt);
	if (
		!Number.isFinite(createdAt) ||
		result.bindingExpiresAt <= createdAt ||
		result.planExpiresAt <= result.bindingExpiresAt
	) {
		invalid();
	}
	assertCrossReferences(result);
	return result;
}

async function validateFingerprint(
	input: MailboxPlanWorkspaceInput,
	computeFingerprint: MailboxPlanBootstrapDeps["computeFingerprint"],
): Promise<void> {
	const fingerprint = await computeFingerprint({
		inventory: input.capture.inventory,
		metadata: input.capture.metadata,
		actions: input.baseRevision.actions,
		targets: input.baseRevision.targets,
	});
	if (
		stable(fingerprint) !==
		stable(input.baseRevision.inventoryFingerprint)
	) {
		invalid();
	}
}

export async function consumeMailboxPlanBootstrap(
	deps: MailboxPlanBootstrapDeps,
): Promise<MailboxPlanWorkspaceInput | undefined> {
	const value = await deps.session.get(MAILBOX_PLAN_BOOTSTRAP_KEY);
	if (value === undefined) return undefined;
	await deps.session.delete(MAILBOX_PLAN_BOOTSTRAP_KEY);
	const input = validateMailboxPlanBootstrap(value);
	await validateFingerprint(input, deps.computeFingerprint);
	return input;
}

export async function writeAndOpenMailboxPlan(
	value: MailboxPlanWorkspaceInput,
	deps: MailboxPlanOpenDeps,
): Promise<void> {
	try {
		preflightMailboxValue(value, {
			maxNodes: 100_000,
			maxKeys: 100_000,
			maxArrayLength: MAILBOX_CAPTURE_LIMITS.messages,
			maxTotalStringLength: MAILBOX_CAPTURE_LIMITS.sanitizedTextCharacters,
			maxTotalBytes: MAILBOX_CAPTURE_LIMITS.sanitizedTextCharacters * 2,
		});
	} catch {
		invalid();
	}
	const sanitized = structuredClone(value) as MailboxPlanWorkspaceInput & {
		capture: SuccessfulMailboxCapture & { bodyChecks?: unknown };
	};
	delete sanitized.capture.bodyChecks;
	const input = validateMailboxPlanBootstrap(sanitized);
	await validateFingerprint(input, deps.computeFingerprint);
	await deps.session.set(MAILBOX_PLAN_BOOTSTRAP_KEY, input);
	try {
		await deps.tabs.create({
			url: deps.runtime.getURL("mailbox-plan.html"),
		});
	} catch (error) {
		await deps.session.delete(MAILBOX_PLAN_BOOTSTRAP_KEY);
		throw error;
	}
}
