import {
	preflightMailboxValue,
	validateCanonicalMailboxAction,
	validateCanonicalMailboxPlanRevision,
} from "@dg/common";
import {
	type CanonicalMailboxExecutionAction,
	type CanonicalMailboxExecutionRevision,
	type MailboxExecutionAuthorityScope,
} from "./contracts";

const ALIAS = /^(acct|run|rev|msg|fld|lbl|flt|act|coh|plan)_[a-f0-9]{32}$/;
const PLAN_ALIAS = /^plan_[a-f0-9]{32}$/;
const REVISION_ALIAS = /^rev_[a-f0-9]{32}$/;
const ACTION_ALIAS = /^act_[a-f0-9]{32}$/;
const FOLDER_ALIAS = /^fld_[a-f0-9]{32}$/;
const LABEL_ALIAS = /^lbl_[a-f0-9]{32}$/;
const FILTER_ALIAS = /^flt_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type PlainRecord = Record<string, unknown>;

export class MailboxExecutionAuthorityError extends Error {
	override readonly name = "MailboxExecutionAuthorityError";
}

function fail(): never {
	throw new MailboxExecutionAuthorityError(
		"Mailbox execution authority was rejected",
	);
}

function record(value: unknown): PlainRecord {
	preflightMailboxValue(value, {
		maxNodes: 250_000,
		maxKeys: 250_000,
		maxArrayLength: 10_000,
		maxTotalStringLength: 2_000_000,
		maxTotalBytes: 4_000_000,
	});
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail();
	}
	return value as PlainRecord;
}

function exact(
	value: PlainRecord,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const keys = Object.keys(value);
	const allowed = new Set([...required, ...optional]);
	if (
		required.some((key) => !Object.hasOwn(value, key)) ||
		keys.some((key) => !allowed.has(key))
	) {
		fail();
	}
}

function alias(value: unknown, pattern = ALIAS): string {
	if (typeof value !== "string" || !pattern.test(value)) fail();
	return value;
}

function aliasArray(value: unknown, pattern: RegExp): readonly string[] {
	if (!Array.isArray(value) || value.length > 10_000) fail();
	const aliases = value.map((item) => alias(item, pattern));
	if (new Set(aliases).size !== aliases.length) fail();
	return Object.freeze(aliases);
}

function validateAction(value: unknown): CanonicalMailboxExecutionAction {
	try {
		return deepFreeze(
			structuredClone(validateCanonicalMailboxAction(value)),
		);
	} catch {
		fail();
	}
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

export function validateCanonicalMailboxExecutionRevision(
	value: unknown,
): CanonicalMailboxExecutionRevision {
	try {
		validateCanonicalMailboxPlanRevision(value);
	} catch {
		fail();
	}
	const input = record(value);
	exact(
		input,
		[
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
		],
	);
	const state = input.state;
	if (
		input.schemaVersion !== 1 ||
		!["approved", "in_flight", "completed", "canceled"].includes(
			String(state),
		) ||
		input.restartRequired !== false ||
		typeof input.revisionNumber !== "number" ||
		!Number.isSafeInteger(input.revisionNumber) ||
		input.revisionNumber < 1 ||
		typeof input.createdAt !== "string" ||
		!TIMESTAMP.test(input.createdAt) ||
		new Date(input.createdAt).toISOString() !== input.createdAt
	) {
		fail();
	}
	const planAlias = alias(input.planAlias, PLAN_ALIAS);
	const revisionAlias = alias(input.revisionAlias, REVISION_ALIAS);
	const revisionNumber = input.revisionNumber;
	const createdAt = input.createdAt;

	const fingerprint = record(input.inventoryFingerprint);
	exact(fingerprint, ["schemaVersion", "algorithm", "digest"]);
	if (
		fingerprint.schemaVersion !== 1 ||
		fingerprint.algorithm !== "sha256" ||
		typeof fingerprint.digest !== "string" ||
		!SHA256.test(fingerprint.digest)
	) {
		fail();
	}
	const inventoryFingerprint = Object.freeze({
		schemaVersion: 1 as const,
		algorithm: "sha256" as const,
		digest: fingerprint.digest,
	});

	const targets = record(input.targets);
	exact(targets, ["folderAliases", "labelAliases", "filterAliases"]);
	const safeTargets = Object.freeze({
		folderAliases: aliasArray(targets.folderAliases, FOLDER_ALIAS),
		labelAliases: aliasArray(targets.labelAliases, LABEL_ALIAS),
		filterAliases: aliasArray(targets.filterAliases, FILTER_ALIAS),
	});

	if (!Array.isArray(input.actions) || input.actions.length > 10_000) fail();
	const actions = input.actions.map(validateAction);
	if (actions.length === 0) fail();
	if (!Array.isArray(input.cohorts)) fail();

	const revision: CanonicalMailboxExecutionRevision = {
		schemaVersion: 1,
		planAlias,
		revisionAlias,
		revisionNumber,
		state: state as CanonicalMailboxExecutionRevision["state"],
		restartRequired: false,
		createdAt,
		inventoryFingerprint,
		targets: safeTargets,
		actions: Object.freeze(actions),
		cohorts: Object.freeze(structuredClone(input.cohorts)),
	};
	return deepFreeze(structuredClone(revision));
}

function exclusiveTarget(
	action: CanonicalMailboxExecutionAction,
): string | undefined {
	switch (action.type) {
		case "create_folder":
			return `folder:create:${String(action.folderAlias)}`;
		case "rename_folder":
			return `folder:mutate:${String(action.folderAlias)}`;
		case "create_label":
		case "create_category":
			return `label:create:${String(action.labelAlias)}`;
		case "rename_label":
		case "rename_category":
			return `label:mutate:${String(action.labelAlias)}`;
		case "create_filter":
			return `filter:create:${String(action.filterAlias)}`;
		case "change_filter":
		case "deactivate_filter":
			return `filter:mutate:${String(action.filterAlias)}`;
		default:
			return undefined;
	}
}

function producedTarget(
	action: CanonicalMailboxExecutionAction,
): string | undefined {
	switch (action.type) {
		case "create_folder":
			return `folder:${String(action.folderAlias)}`;
		case "rename_folder":
			return `folder:${String(action.replacementFolderAlias)}`;
		case "create_label":
		case "create_category":
			return `label:${String(action.labelAlias)}`;
		case "rename_label":
		case "rename_category":
			return `label:${String(action.replacementLabelAlias)}`;
		case "create_filter":
			return `filter:${String(action.filterAlias)}`;
		case "change_filter":
			return `filter:${String(action.replacementFilterAlias)}`;
		default:
			return undefined;
	}
}

function consumedTargets(
	action: CanonicalMailboxExecutionAction,
): readonly string[] {
	switch (action.type) {
		case "move_to_folder":
		case "rename_folder":
			return [`folder:${String(action.folderAlias)}`];
		case "apply_label":
		case "apply_category":
		case "rename_label":
		case "rename_category":
			return [`label:${String(action.labelAlias)}`];
		case "change_filter":
		case "deactivate_filter":
			return [`filter:${String(action.filterAlias)}`];
		default:
			return [];
	}
}

export function buildMailboxExecutionAuthorityScope(
	actions: readonly CanonicalMailboxExecutionAction[],
): MailboxExecutionAuthorityScope {
	const targets = {
		folderAliases: new Set<string>(),
		labelAliases: new Set<string>(),
		filterAliases: new Set<string>(),
	};
	for (const action of actions) {
		for (const [field, value] of Object.entries(action)) {
			if (typeof value !== "string") continue;
			if (
				field === "folderAlias" ||
				field === "replacementFolderAlias"
			) {
				targets.folderAliases.add(value);
			}
			if (
				field === "labelAlias" ||
				field === "replacementLabelAlias"
			) {
				targets.labelAliases.add(value);
			}
			if (
				field === "filterAlias" ||
				field === "replacementFilterAlias"
			) {
				targets.filterAliases.add(value);
			}
		}
	}
	return deepFreeze({
		schemaVersion: 1,
		actionAliases: actions.map((action) => action.actionAlias),
		targets: {
			folderAliases: [...targets.folderAliases].sort(),
			labelAliases: [...targets.labelAliases].sort(),
			filterAliases: [...targets.filterAliases].sort(),
		},
	});
}

export function buildMailboxExecutionGraph(
	actions: readonly CanonicalMailboxExecutionAction[],
): readonly number[] {
	const indices = new Map<string, number>();
	const exclusiveTargets = new Set<string>();
	const producedTargets = new Map<string, number>();
	for (const [index, action] of actions.entries()) {
		if (indices.has(action.actionAlias)) fail();
		indices.set(action.actionAlias, index);
		const target = exclusiveTarget(action);
		if (target !== undefined) {
			if (exclusiveTargets.has(target)) fail();
			exclusiveTargets.add(target);
		}
		const produced = producedTarget(action);
		if (produced !== undefined) {
			if (producedTargets.has(produced)) fail();
			producedTargets.set(produced, index);
		}
	}

	const indegree = actions.map(() => 0);
	const dependents = actions.map(() => [] as number[]);
	const prerequisites = actions.map(() => new Set<number>());
	for (const [index, action] of actions.entries()) {
		for (const dependency of action.dependsOn ?? []) {
			const dependencyIndex = indices.get(dependency);
			if (dependencyIndex === undefined || dependencyIndex === index) fail();
			prerequisites[index]?.add(dependencyIndex);
		}
		for (const consumed of consumedTargets(action)) {
			const producerIndex = producedTargets.get(consumed);
			if (producerIndex !== undefined && producerIndex !== index) {
				const producer = actions[producerIndex];
				if (
					producer === undefined ||
					!action.dependsOn?.includes(producer.actionAlias)
				) {
					fail();
				}
			}
		}
	}
	const messageActions = new Map<string, number[]>();
	for (const [index, action] of actions.entries()) {
		if (!("messageAlias" in action)) continue;
		const grouped = messageActions.get(action.messageAlias) ?? [];
		grouped.push(index);
		messageActions.set(action.messageAlias, grouped);
	}
	for (const grouped of messageActions.values()) {
		const mutations = grouped.filter((index) => {
			const type = actions[index]?.type;
			return type !== "move_to_folder" && type !== "archive";
		});
		const moves = grouped.filter(
			(index) => actions[index]?.type === "move_to_folder",
		);
		const archives = grouped.filter(
			(index) => actions[index]?.type === "archive",
		);
		for (const terminal of [...moves, ...archives]) {
			for (const mutation of mutations) {
				prerequisites[terminal]?.add(mutation);
			}
		}
		for (const archive of archives) {
			for (const move of moves) prerequisites[archive]?.add(move);
		}
	}
	for (const [index, required] of prerequisites.entries()) {
		indegree[index] = required.size;
		for (const prerequisite of required) {
			dependents[prerequisite]?.push(index);
		}
	}

	const ready = indegree
		.map((degree, index) => ({ degree, index }))
		.filter(({ degree }) => degree === 0)
		.map(({ index }) => index);
	const order: number[] = [];
	while (ready.length > 0) {
		ready.sort((left, right) => left - right);
		const index = ready.shift();
		if (index === undefined) break;
		order.push(index);
		for (const dependent of dependents[index] ?? []) {
			indegree[dependent] -= 1;
			if (indegree[dependent] === 0) ready.push(dependent);
		}
	}
	if (order.length !== actions.length) fail();
	return Object.freeze(order);
}
