import {
	preflightMailboxValue,
	validateCanonicalMailboxActions,
	validateMailboxAction,
	validateMailboxPlanRevision,
	type MailboxAction,
	type MailboxPlanRevision,
	type MailboxRevisionTargets,
} from "@dg/common";
import type { RawBindingScope } from "../storage";
import type {
	MailboxChoiceId,
	MailboxMessageEditAction,
	MailboxPlanEdit,
	MailboxPlanSnapshot,
	MailboxPlanWorkspace,
	MailboxPlanWorkspaceDeps,
	MailboxPlanWorkspaceInput,
} from "./contracts";

const CHOICE_POSITION = {
	conservative: 0,
	balanced: 50,
	inbox_zero: 100,
} as const;

const MAX_EXCLUSIONS = 5_000;
const LOCATION_EDIT_KEY = "location";
const MARK_READ_EDIT_KEY = "mark_read";
const LABEL_RESET_EDIT_KEY = "labels";

export class MailboxPlanWorkspaceError extends Error {
	override readonly name = "MailboxPlanWorkspaceError";

	constructor(
		readonly code:
			| "invalid_input"
			| "invalid_edit"
			| "binding_expired"
			| "plan_expired"
			| "restart_required"
			| "empty_capture"
			| "chat_unavailable"
			| "busy"
			| "invalid_state",
	) {
		super(`Mailbox plan workspace rejected: ${code}`);
	}
}

function fail(code: MailboxPlanWorkspaceError["code"]): never {
	throw new MailboxPlanWorkspaceError(code);
}

function exactRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	try {
		preflightMailboxValue(value);
	} catch {
		fail("invalid_edit");
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		fail("invalid_edit");
	}
	const input = value as Record<string, unknown>;
	const keys = Object.keys(input);
	const allowed = new Set([...required, ...optional]);
	if (
		required.some((key) => !Object.hasOwn(input, key)) ||
		keys.some((key) => !allowed.has(key))
	) {
		fail("invalid_edit");
	}
	return input;
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

function messageEditKey(
	action: MailboxMessageEditAction,
	messageAlias: string,
	labelAlias?: string,
): string {
	switch (action) {
		case "archive":
		case "move_to_folder":
			return LOCATION_EDIT_KEY;
		case "mark_read":
			return MARK_READ_EDIT_KEY;
		case "apply_label":
		case "remove_label":
			return `${action}:${messageAlias}:${labelAlias}`;
	}
}

function uniqueActions(actions: readonly MailboxAction[]): readonly MailboxAction[] {
	const byKey = new Map<string, MailboxAction>();
	for (const action of actions) byKey.set(actionKey(action), action);
	return Object.freeze([...byKey.values()]);
}

function hasLocationConflict(actions: readonly MailboxAction[]): boolean {
	const seen = new Set<string>();
	for (const action of actions) {
		if (
			action.type !== "archive" &&
			action.type !== "move_to_folder"
		) {
			continue;
		}
		if (seen.has(action.messageAlias)) return true;
		seen.add(action.messageAlias);
	}
	return false;
}

function messageAction(
	action: MailboxMessageEditAction,
	messageAlias: string,
	folderAlias?: string,
	labelAlias?: string,
): MailboxAction {
	switch (action) {
		case "archive":
			return validateMailboxAction({ type: action, messageAlias });
		case "mark_read":
			return validateMailboxAction({ type: action, messageAlias });
		case "move_to_folder":
			return validateMailboxAction({
				type: action,
				messageAlias,
				folderAlias,
			});
		case "apply_label":
		case "remove_label":
			return validateMailboxAction({
				type: action,
				messageAlias,
				labelAlias,
			});
	}
}

function frozenRevision(value: MailboxPlanRevision): MailboxPlanRevision {
	return deepFreeze(
		validateMailboxPlanRevision(structuredClone(value)),
	);
}

export function createMailboxPlanWorkspace(
	input: MailboxPlanWorkspaceInput,
	deps: MailboxPlanWorkspaceDeps,
): MailboxPlanWorkspace {
	let revision: MailboxPlanRevision;
	try {
		input = deepFreeze(structuredClone(input));
		revision = frozenRevision(validateMailboxPlanRevision(input.baseRevision));
	} catch {
		fail("invalid_input");
	}
	if (
		revision.planAlias !== input.bindingScope.planAlias ||
		input.capture.inventory.accountAlias !==
			input.bindingScope.accountAlias ||
		input.capture.inventory.runAlias !== input.bindingScope.runAlias ||
		input.capture.inventory.providerId !==
			input.bindingScope.providerId ||
		input.capture.inventory.surface !== input.bindingScope.surface ||
		!Number.isSafeInteger(input.bindingExpiresAt) ||
		!Number.isSafeInteger(input.planExpiresAt) ||
		hasLocationConflict(revision.actions)
	) {
		fail("invalid_input");
	}

	const choices = new Map(
		input.capture.choices.map((choice) => [choice.id, choice]),
	);
	if (
		!choices.has("conservative") ||
		!choices.has("balanced") ||
		!choices.has("inbox_zero")
	) {
		fail("invalid_input");
	}
	const messages = new Set(
		input.capture.inventory.messages.map((message) => message.alias),
	);
	const folders = new Set(
		input.capture.inventory.folders.map((folder) => folder.alias),
	);
	const labels = new Set([
		...input.capture.inventory.labels.map((label) => label.alias),
		...input.capture.metadata.tags.map((tag) => tag.alias),
		...input.capture.metadata.categories.map((category) => category.alias),
	]);
	const filters = new Set(
		input.capture.inventory.filters.map((filter) => filter.alias),
	);
	const cohorts = new Map(
		input.capture.cohorts.map((cohort) => [cohort.cohortKey, cohort]),
	);

	const matchingChoice = input.capture.choices.find(
		(choice) =>
			JSON.stringify(uniqueActions(choice.actions)) ===
			JSON.stringify(uniqueActions(revision.actions)),
	);
	let selectedChoiceId: MailboxChoiceId =
		matchingChoice?.id ?? "conservative";
	let presetSelected = false;
	let choiceOverridesChat = false;
	const reopenedActions = Object.freeze(
		revision.actions.map((action) =>
			Object.freeze(validateMailboxAction(structuredClone(action))),
		),
	);
	let chatProposal: MailboxPlanRevision | undefined;
	const cohortEdits = new Map<
		string,
		"archive" | "mark_read" | "review"
	>();
	const messageExceptions = new Map<string, MailboxAction>();
	const messageActionEdits = new Map<
		string,
		Map<string, MailboxAction | false>
	>();
	const exclusions = new Set<string>();
	const filterEdits = new Map<string, "deactivate_filter" | "review">();
	const baselineTargets = revision.targets;
	const userTargetEdits = {
		folder: new Map<string, boolean>(),
		label: new Map<string, boolean>(),
		filter: new Map<string, boolean>(),
	};
	const localReview = new Set<string>();
	for (const hint of input.localHints ?? []) {
		if (hint.classification !== "needs_review") continue;
		for (const alias of cohorts.get(hint.cohortKey)?.messageAliases ?? []) {
			localReview.add(alias);
		}
	}

	let bindingExpiresAt = input.bindingExpiresAt;
	let bindingAvailable =
		deps.now() < input.bindingExpiresAt &&
		!revision.restartRequired;
	let activeBindingScope = input.bindingScope;
	let restartRequired = revision.restartRequired || !bindingAvailable;
	let transitionPending = false;
	let dirty = false;
	let announcement = "";
	let operationStatus: MailboxPlanSnapshot["operationStatus"] = "idle";
	let chatInitiallyOpen = false;
	try {
		chatInitiallyOpen =
			typeof deps.bridge.isOpen === "function" &&
			deps.bridge.isOpen() === true;
	} catch {
		chatInitiallyOpen = false;
	}
	let chatStatus: MailboxPlanSnapshot["chatStatus"] =
		chatInitiallyOpen ? "idle" : "disconnected";
	let chatMessage = chatInitiallyOpen
		? ""
		: "Chat is disconnected. Reconnect before submitting.";
	let canReconnect = !chatInitiallyOpen;
	const listeners = new Set<(snapshot: MailboxPlanSnapshot) => void>();
	const idleWaiters = new Set<() => void>();

	const planExpired = (): boolean => deps.now() >= input.planExpiresAt;
	const bridgeIsOpen = (): boolean => {
		try {
			return (
				typeof deps.bridge.isOpen === "function" &&
				deps.bridge.isOpen() === true
			);
		} catch {
			return false;
		}
	};

	const selectedTargets = (
		kind: "folder" | "label" | "filter",
		baseline: readonly string[],
		available: ReadonlySet<string>,
	): readonly string[] => {
		const selected = new Set(baseline.filter((alias) => available.has(alias)));
		for (const [alias, enabled] of userTargetEdits[kind]) {
			if (enabled) selected.add(alias);
			else selected.delete(alias);
		}
		return Object.freeze([...selected].sort());
	};

	const currentTargets = (): MailboxRevisionTargets => {
		const source = chatProposal?.targets ?? baselineTargets;
		return deepFreeze({
			folderAliases: selectedTargets(
				"folder",
				source.folderAliases,
				folders,
			),
			labelAliases: selectedTargets(
				"label",
				source.labelAliases,
				labels,
			),
			filterAliases: selectedTargets(
				"filter",
				source.filterAliases,
				filters,
			),
		});
	};

	const computed = (): {
		actions: readonly MailboxAction[];
		review: readonly string[];
	} => {
		const choice = choices.get(selectedChoiceId);
		if (choice === undefined) fail("invalid_input");
		const useChoice = presetSelected || choiceOverridesChat;
		const baselineActions = useChoice
			? choice.actions
			: chatProposal?.actions ?? reopenedActions;
		let actions = [...baselineActions];
		const review = new Set<string>(
			useChoice
				? choice.reviewMessageAliases
				: chatProposal !== undefined
					? input.capture.inventory.messages.map(
							(message) => message.alias,
						)
					: [],
		);

		for (const alias of localReview) {
			if (chatProposal === undefined && !presetSelected) {
				actions = actions.filter(
					(action) =>
						!("messageAlias" in action) ||
						action.messageAlias !== alias,
				);
				review.add(alias);
			}
		}
		if (chatProposal !== undefined && !choiceOverridesChat) {
			for (const action of chatProposal.actions) {
				if ("messageAlias" in action) review.delete(action.messageAlias);
			}
		}

		for (const [cohortKey, edit] of cohortEdits) {
			for (const alias of cohorts.get(cohortKey)?.messageAliases ?? []) {
				actions = actions.filter(
					(action) =>
						!("messageAlias" in action) ||
						action.messageAlias !== alias,
				);
				if (edit === "review") {
					review.add(alias);
				} else {
					actions.push({ type: edit, messageAlias: alias });
					review.delete(alias);
				}
			}
		}

		for (const [alias, action] of messageExceptions) {
			actions = actions.filter(
				(candidate) =>
					!("messageAlias" in candidate) ||
					candidate.messageAlias !== alias,
			);
			actions.push(action);
			review.delete(alias);
		}
		for (const [alias, edits] of messageActionEdits) {
			const location = edits.get(LOCATION_EDIT_KEY);
			if (location !== undefined) {
				actions = actions.filter(
					(candidate) =>
						!("messageAlias" in candidate) ||
						candidate.messageAlias !== alias ||
						(candidate.type !== "archive" &&
							candidate.type !== "move_to_folder"),
				);
				if (location !== false) actions.push(location);
			}
			const markRead = edits.get(MARK_READ_EDIT_KEY);
			if (markRead !== undefined) {
				actions = actions.filter(
					(candidate) =>
						!("messageAlias" in candidate) ||
						candidate.messageAlias !== alias ||
						candidate.type !== "mark_read",
				);
				if (markRead !== false) actions.push(markRead);
			}
			if (edits.has(LABEL_RESET_EDIT_KEY)) {
				actions = actions.filter(
					(candidate) =>
						!("messageAlias" in candidate) ||
						candidate.messageAlias !== alias ||
						(candidate.type !== "apply_label" &&
							candidate.type !== "remove_label"),
				);
			}
			for (const [key, action] of edits) {
				if (
					key === LOCATION_EDIT_KEY ||
					key === MARK_READ_EDIT_KEY ||
					key === LABEL_RESET_EDIT_KEY
				) {
					continue;
				}
				actions = actions.filter(
					(candidate) =>
						!("messageAlias" in candidate) ||
						candidate.messageAlias !== alias ||
						actionKey(candidate) !== key,
				);
				if (action !== false) actions.push(action);
			}
		}
		for (const alias of exclusions) {
			actions = actions.filter(
				(action) =>
					!("messageAlias" in action) ||
					action.messageAlias !== alias,
			);
			review.add(alias);
		}

		for (const [filterAlias, action] of filterEdits) {
			actions = actions.filter(
				(candidate) =>
					candidate.type !== "deactivate_filter" ||
					candidate.filterAlias !== filterAlias,
			);
			if (action === "deactivate_filter") {
				actions.push({ type: action, filterAlias });
			}
		}

		const targets = currentTargets();
		const selectedFolders = new Set(targets.folderAliases);
		const selectedLabels = new Set(targets.labelAliases);
		const selectedFilters = new Set(targets.filterAliases);
		actions = actions.filter((action) => {
			const valid =
				(action.type !== "move_to_folder" ||
					selectedFolders.has(action.folderAlias)) &&
				((action.type !== "apply_label" &&
					action.type !== "remove_label") ||
					selectedLabels.has(action.labelAlias)) &&
				(action.type !== "deactivate_filter" ||
					selectedFilters.has(action.filterAlias));
			if (!valid && "messageAlias" in action) {
				review.add(action.messageAlias);
			}
			return valid;
		});

		const unique = Object.freeze(
			uniqueActions(actions).map((action) =>
				Object.freeze(validateMailboxAction(structuredClone(action))),
			),
		);
		const acted = new Set(
			unique.flatMap((action) =>
				"messageAlias" in action ? [action.messageAlias] : [],
			),
		);
		for (const alias of messages) {
			if (!acted.has(alias)) review.add(alias);
			else if (!exclusions.has(alias)) review.delete(alias);
		}
		return {
			actions: unique,
			review: Object.freeze([...review].sort()),
		};
	};

	type OperationPlanSnapshot = Readonly<{
		actions: readonly MailboxAction[];
		targets: MailboxRevisionTargets;
	}>;

	const operationPlanSnapshot = (): OperationPlanSnapshot => {
		const { actions } = computed();
		const targets = currentTargets();
		return Object.freeze({
			actions: Object.freeze(
				actions.map((action) =>
					Object.freeze(
						validateMailboxAction(structuredClone(action)),
					),
				),
			),
			targets: Object.freeze({
				folderAliases: Object.freeze([
					...targets.folderAliases,
				]),
				labelAliases: Object.freeze([...targets.labelAliases]),
				filterAliases: Object.freeze([...targets.filterAliases]),
			}),
		});
	};

	const getSnapshot = (): MailboxPlanSnapshot => {
		const { actions, review } = computed();
		const archived = actions.filter(
			(action) =>
				action.type === "archive" ||
				action.type === "move_to_folder",
		).length;
		const markedRead = actions.filter(
			(action) => action.type === "mark_read",
		).length;
		return Object.freeze({
			captureCounts: input.capture.counts,
			cohorts: input.capture.cohorts,
			coverage: input.capture.status === "partial" ? "partial" : "complete",
			uncapturedCount:
				input.capture.status === "partial" ? "unknown" : 0,
			selectedChoiceId,
			sliderPosition: CHOICE_POSITION[selectedChoiceId],
			actions,
			targets: currentTargets(),
			reviewMessageAliases: review,
			excludedMessageAliases: Object.freeze([...exclusions].sort()),
			revision,
			restartRequired,
			bindingAvailable,
			bindingExpiresAt,
			planExpiresAt: input.planExpiresAt,
			planExpired: planExpired(),
			transitionPending,
			chatAvailable:
				input.capture.status === "complete" &&
				!planExpired() &&
				bridgeIsOpen(),
			dirty,
			outcome: Object.freeze({
				archived,
				markedRead,
				review: review.length,
				deleted: 0 as const,
			}),
			announcement,
			operationStatus,
			chatStatus,
			chatMessage,
			canReconnect,
			editorInventory: Object.freeze({
				messageAliases: Object.freeze([...messages].sort()),
				messages: Object.freeze(
					input.capture.inventory.messages
						.map((message) =>
							Object.freeze({
								alias: message.alias,
								category: message.category,
								receivedAt: message.receivedAt,
								read: message.read,
								hasAttachments: message.hasAttachments,
							}),
						)
						.sort((left, right) =>
							left.alias.localeCompare(right.alias),
						),
				),
				folderAliases: Object.freeze(
					input.capture.inventory.folders
						.map((item) => item.alias)
						.sort(),
				),
				labelAliases: Object.freeze(
					input.capture.inventory.labels
						.map((item) => item.alias)
						.sort(),
				),
				tagAliases: Object.freeze(
					input.capture.metadata.tags
						.map((item) => item.alias)
						.sort(),
				),
				categoryAliases: Object.freeze(
					input.capture.metadata.categories
						.map((item) => item.alias)
						.sort(),
				),
				filterAliases: Object.freeze([...filters].sort()),
			}),
		});
	};

	const notify = (): void => {
		const snapshot = getSnapshot();
		for (const listener of listeners) listener(snapshot);
	};

	const beginOperation = (
		status: Exclude<
			MailboxPlanSnapshot["operationStatus"],
			"idle"
		>,
	): (() => void) => {
		if (operationStatus !== "idle") fail("busy");
		operationStatus = status;
		transitionPending = true;
		notify();
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			operationStatus = "idle";
			transitionPending = false;
			notify();
			for (const resolve of idleWaiters) resolve();
			idleWaiters.clear();
		};
	};

	const waitForIdle = async (): Promise<void> => {
		if (operationStatus === "idle") return;
		await new Promise<void>((resolve) => idleWaiters.add(resolve));
	};

	const markBindingExpired = (): void => {
		bindingAvailable = false;
		restartRequired = true;
		revision = frozenRevision(
			validateMailboxPlanRevision({
				...revision,
				restartRequired: true,
			}),
		);
		notify();
	};

	const requirePlan = (): void => {
		if (planExpired()) fail("plan_expired");
	};

	const requireMutableState = (): void => {
		if (
			revision.state === "canceled" ||
			revision.state === "completed" ||
			revision.state === "in_flight"
		) {
			fail("invalid_state");
		}
	};

	const refreshBindingStatus = async (): Promise<boolean> => {
		requirePlan();
		if (deps.rawBindings.status === undefined) {
			if (deps.now() >= bindingExpiresAt) markBindingExpired();
			return bindingAvailable;
		}
		const status = await deps.rawBindings.status(activeBindingScope);
		requirePlan();
		if (!status.available || deps.now() >= status.expiresAt) {
			markBindingExpired();
			return false;
		}
		bindingAvailable = true;
		bindingExpiresAt = status.expiresAt;
		return true;
	};

	const requireUserDecision = async (): Promise<void> => {
		requirePlan();
		if (
			!bindingAvailable ||
			!(await deps.rawBindings.touch(
				activeBindingScope,
				"user_decision",
			))
		) {
			markBindingExpired();
			fail("binding_expired");
		}
		requirePlan();
		if (!(await refreshBindingStatus())) fail("binding_expired");
		requirePlan();
	};

	const draftValue = async (
		revisionAlias: string,
		plan: OperationPlanSnapshot,
		knownFingerprint?: MailboxPlanRevision["inventoryFingerprint"],
	): Promise<MailboxPlanRevision> => {
		const fingerprint =
			knownFingerprint ??
			(await deps.computeFingerprint({
				inventory: input.capture.inventory,
				metadata: input.capture.metadata,
				actions: plan.actions,
				targets: plan.targets,
			}));
		requirePlan();
		return frozenRevision(
			validateMailboxPlanRevision({
				schemaVersion: 1,
				planAlias: revision.planAlias,
				revisionAlias,
				revisionNumber: revision.revisionNumber + 1,
				state: "draft",
				restartRequired,
				createdAt: new Date(deps.now()).toISOString(),
				inventoryFingerprint: fingerprint,
				cohorts: input.capture.cohorts,
				targets: plan.targets,
				actions: plan.actions,
			}),
		);
	};

	const rebind = async (
		revisionAlias: string,
	): Promise<RawBindingScope | undefined> => {
		if (
			revisionAlias === activeBindingScope.revisionAlias ||
			deps.rawBindings.put === undefined
		) {
			return undefined;
		}
		const bindings = await deps.rawBindings.get(activeBindingScope);
		requirePlan();
		if (bindings === undefined) {
			markBindingExpired();
			fail("binding_expired");
		}
		const scope = {
			...activeBindingScope,
			revisionAlias,
		};
		await deps.rawBindings.put(scope, bindings);
		requirePlan();
		if (deps.rawBindings.status !== undefined) {
			const status = await deps.rawBindings.status(scope);
			requirePlan();
			if (!status.available) {
				markBindingExpired();
				fail("binding_expired");
			}
			bindingExpiresAt = status.expiresAt;
		}
		return scope;
	};

	const persistDraft = async (
		plan: OperationPlanSnapshot,
		rebindBinding = false,
		knownFingerprint?: MailboxPlanRevision["inventoryFingerprint"],
	): Promise<MailboxPlanRevision> => {
		requirePlan();
		const nextRevisionAlias = deps.createRevisionAlias();
		const nextBindingScope =
			rebindBinding && bindingAvailable
				? await rebind(nextRevisionAlias)
				: undefined;
		requirePlan();
		const draft = await draftValue(
			nextRevisionAlias,
			plan,
			knownFingerprint,
		);
		requirePlan();
		if (rebindBinding && !(await refreshBindingStatus())) {
			fail("binding_expired");
		}
		requirePlan();
		const stored = await deps.lifecycle.edit(
			revision.planAlias,
			revision.revisionAlias,
			draft,
		);
		requirePlan();
		revision = frozenRevision(validateMailboxPlanRevision(stored));
		if (nextBindingScope !== undefined) {
			activeBindingScope = nextBindingScope;
		}
		await deps.registerRevision?.(
			revision.planAlias,
			revision.revisionAlias,
		);
		requirePlan();
		dirty = false;
		return revision;
	};

	const validateEdit = (value: MailboxPlanEdit): MailboxPlanEdit => {
		const type =
			value !== null && typeof value === "object"
				? (value as { type?: unknown }).type
				: undefined;
		switch (type) {
			case "set_cohort_action": {
				const edit = exactRecord(value, [
					"type",
					"cohortKey",
					"action",
				]);
				if (
					typeof edit.cohortKey !== "string" ||
					!cohorts.has(edit.cohortKey) ||
					(edit.action !== "archive" &&
						edit.action !== "mark_read" &&
						edit.action !== "review")
				) {
					fail("invalid_edit");
				}
				return value;
			}
			case "set_message_exception": {
				const edit = exactRecord(
					value,
					["type", "messageAlias", "action"],
					["folderAlias", "labelAlias"],
				);
				if (
					typeof edit.messageAlias !== "string" ||
					!messages.has(edit.messageAlias) ||
					(edit.action !== "archive" &&
						edit.action !== "mark_read" &&
						edit.action !== "move_to_folder" &&
						edit.action !== "apply_label" &&
						edit.action !== "remove_label")
				) {
					fail("invalid_edit");
				}
				const hasFolder = Object.hasOwn(edit, "folderAlias");
				const hasLabel = Object.hasOwn(edit, "labelAlias");
				if (
					((edit.action === "archive" ||
						edit.action === "mark_read") &&
						(hasFolder || hasLabel)) ||
					(edit.action === "move_to_folder" &&
						(!hasFolder || hasLabel)) ||
					((edit.action === "apply_label" ||
						edit.action === "remove_label") &&
						(!hasLabel || hasFolder))
				) {
					fail("invalid_edit");
				}
				const action = messageAction(
					edit.action,
					edit.messageAlias,
					typeof edit.folderAlias === "string"
						? edit.folderAlias
						: undefined,
					typeof edit.labelAlias === "string"
						? edit.labelAlias
						: undefined,
				);
				if (
					(action.type === "move_to_folder" &&
						!folders.has(action.folderAlias)) ||
					((action.type === "apply_label" ||
						action.type === "remove_label") &&
						!labels.has(action.labelAlias))
				) {
					fail("invalid_edit");
				}
				return value;
			}
			case "set_message_action": {
				const edit = exactRecord(
					value,
					["type", "messageAlias", "action", "selected"],
					["folderAlias", "labelAlias"],
				);
				if (
					typeof edit.messageAlias !== "string" ||
					!messages.has(edit.messageAlias) ||
					typeof edit.selected !== "boolean" ||
					(edit.action !== "archive" &&
						edit.action !== "mark_read" &&
						edit.action !== "move_to_folder" &&
						edit.action !== "apply_label" &&
						edit.action !== "remove_label")
				) {
					fail("invalid_edit");
				}
				const hasFolder = Object.hasOwn(edit, "folderAlias");
				const hasLabel = Object.hasOwn(edit, "labelAlias");
				if (
					((edit.action === "archive" ||
						edit.action === "mark_read") &&
						(hasFolder || hasLabel)) ||
					(edit.action === "move_to_folder" &&
						(edit.selected
							? !hasFolder || hasLabel
							: hasFolder || hasLabel)) ||
					((edit.action === "apply_label" ||
						edit.action === "remove_label") &&
						(!hasLabel || hasFolder))
				) {
					fail("invalid_edit");
				}
				if (
					(edit.selected === true &&
						edit.action === "move_to_folder" &&
						(typeof edit.folderAlias !== "string" ||
							!folders.has(edit.folderAlias))) ||
					((edit.action === "apply_label" ||
						edit.action === "remove_label") &&
						(typeof edit.labelAlias !== "string" ||
							!labels.has(edit.labelAlias)))
				) {
					fail("invalid_edit");
				}
				return value;
			}
			case "exclude_message":
			case "include_message": {
				const edit = exactRecord(value, ["type", "messageAlias"]);
				if (
					typeof edit.messageAlias !== "string" ||
					!messages.has(edit.messageAlias)
				) {
					fail("invalid_edit");
				}
				return value;
			}
			case "set_bulk_exclusions": {
				const edit = exactRecord(value, ["type", "messageAliases"]);
				if (
					!Array.isArray(edit.messageAliases) ||
					edit.messageAliases.length > MAX_EXCLUSIONS ||
					new Set(edit.messageAliases).size !==
						edit.messageAliases.length ||
					edit.messageAliases.some(
						(alias) =>
							typeof alias !== "string" || !messages.has(alias),
					)
				) {
					fail("invalid_edit");
				}
				return value;
			}
			case "set_filter_action": {
				const edit = exactRecord(value, [
					"type",
					"filterAlias",
					"action",
				]);
				if (
					typeof edit.filterAlias !== "string" ||
					!filters.has(edit.filterAlias) ||
					(edit.action !== "deactivate_filter" &&
						edit.action !== "review")
				) {
					fail("invalid_edit");
				}
				return value;
			}
			case "set_target": {
				const edit = exactRecord(value, [
					"type",
					"targetKind",
					"alias",
					"selected",
				]);
				const collection =
					edit.targetKind === "folder"
						? folders
						: edit.targetKind === "label"
							? labels
							: edit.targetKind === "filter"
								? filters
								: undefined;
				if (
					collection === undefined ||
					typeof edit.alias !== "string" ||
					!collection.has(edit.alias) ||
					typeof edit.selected !== "boolean"
				) {
					fail("invalid_edit");
				}
				return value;
			}
			case "apply_chat_proposal": {
				const edit = exactRecord(value, ["type", "proposal"]);
				let proposal: MailboxPlanRevision;
				try {
					proposal = validateMailboxPlanRevision(edit.proposal);
				} catch {
					fail("invalid_edit");
				}
				if (
					proposal.planAlias !== revision.planAlias ||
					proposal.state !== "draft" ||
					hasLocationConflict(proposal.actions) ||
					JSON.stringify(proposal.cohorts) !==
						JSON.stringify(input.capture.cohorts)
				) {
					fail("invalid_edit");
				}
				return value;
			}
			default:
				fail("invalid_edit");
		}
	};

	const applyValidatedEdit = (edit: MailboxPlanEdit): void => {
		switch (edit.type) {
			case "set_cohort_action":
				cohortEdits.set(edit.cohortKey, edit.action);
				break;
			case "set_message_exception":
				messageActionEdits.delete(edit.messageAlias);
				messageExceptions.set(
					edit.messageAlias,
					messageAction(
						edit.action,
						edit.messageAlias,
						edit.folderAlias,
						edit.labelAlias,
					),
				);
				if (
					edit.action === "move_to_folder" &&
					edit.folderAlias !== undefined
				) {
					userTargetEdits.folder.set(edit.folderAlias, true);
				}
				if (
					(edit.action === "apply_label" ||
						edit.action === "remove_label") &&
					edit.labelAlias !== undefined
				) {
					userTargetEdits.label.set(edit.labelAlias, true);
				}
				break;
			case "set_message_action": {
				let edits = messageActionEdits.get(edit.messageAlias);
				if (edits === undefined) {
					edits = new Map();
					const exception = messageExceptions.get(edit.messageAlias);
					if (
						exception !== undefined &&
						exception.type !== "deactivate_filter"
					) {
						edits.set(LOCATION_EDIT_KEY, false);
						edits.set(MARK_READ_EDIT_KEY, false);
						edits.set(LABEL_RESET_EDIT_KEY, false);
						edits.set(
							messageEditKey(
								exception.type,
								exception.messageAlias,
								exception.type === "apply_label" ||
									exception.type === "remove_label"
									? exception.labelAlias
									: undefined,
							),
							exception,
						);
						messageExceptions.delete(edit.messageAlias);
					}
					messageActionEdits.set(edit.messageAlias, edits);
				}
				const action = edit.selected
					? messageAction(
							edit.action,
							edit.messageAlias,
							edit.folderAlias,
							edit.labelAlias,
						)
					: false;
				edits.set(
					messageEditKey(
						edit.action,
						edit.messageAlias,
						edit.labelAlias,
					),
					action,
				);
				if (
					action !== false &&
					action.type === "move_to_folder"
				) {
					userTargetEdits.folder.set(action.folderAlias, true);
				}
				if (
					action !== false &&
					(action.type === "apply_label" ||
						action.type === "remove_label")
				) {
					userTargetEdits.label.set(action.labelAlias, true);
				}
				break;
			}
			case "exclude_message":
				exclusions.add(edit.messageAlias);
				break;
			case "include_message":
				exclusions.delete(edit.messageAlias);
				break;
			case "set_bulk_exclusions":
				exclusions.clear();
				for (const alias of edit.messageAliases) exclusions.add(alias);
				break;
			case "set_filter_action":
				filterEdits.set(edit.filterAlias, edit.action);
				break;
			case "set_target":
				userTargetEdits[edit.targetKind].set(edit.alias, edit.selected);
				break;
			case "apply_chat_proposal":
				chatProposal = frozenRevision(
					validateMailboxPlanRevision(edit.proposal),
				);
				break;
		}
		dirty = true;
	};

	type EditorState = Readonly<{
		revision: MailboxPlanRevision;
		selectedChoiceId: MailboxChoiceId;
		presetSelected: boolean;
		choiceOverridesChat: boolean;
		chatProposal: MailboxPlanRevision | undefined;
		cohortEdits: ReadonlyMap<string, "archive" | "mark_read" | "review">;
		messageExceptions: ReadonlyMap<string, MailboxAction>;
		messageActionEdits: ReadonlyMap<
			string,
			ReadonlyMap<string, MailboxAction | false>
		>;
		exclusions: ReadonlySet<string>;
		filterEdits: ReadonlyMap<string, "deactivate_filter" | "review">;
		userTargetEdits: Readonly<{
			folder: ReadonlyMap<string, boolean>;
			label: ReadonlyMap<string, boolean>;
			filter: ReadonlyMap<string, boolean>;
		}>;
		dirty: boolean;
		announcement: string;
	}>;

	const editorState = (): EditorState => ({
		revision,
		selectedChoiceId,
		presetSelected,
		choiceOverridesChat,
		chatProposal,
		cohortEdits: new Map(cohortEdits),
		messageExceptions: new Map(messageExceptions),
		messageActionEdits: new Map(
			[...messageActionEdits].map(([alias, edits]) => [
				alias,
				new Map(edits),
			]),
		),
		exclusions: new Set(exclusions),
		filterEdits: new Map(filterEdits),
		userTargetEdits: {
			folder: new Map(userTargetEdits.folder),
			label: new Map(userTargetEdits.label),
			filter: new Map(userTargetEdits.filter),
		},
		dirty,
		announcement,
	});

	const replaceMap = <K, V>(
		target: Map<K, V>,
		source: ReadonlyMap<K, V>,
	): void => {
		target.clear();
		for (const [key, value] of source) target.set(key, value);
	};

	const restoreEditorState = (state: EditorState): void => {
		if (!revision.restartRequired || state.revision.restartRequired) {
			revision = state.revision;
		}
		selectedChoiceId = state.selectedChoiceId;
		presetSelected = state.presetSelected;
		choiceOverridesChat = state.choiceOverridesChat;
		chatProposal = state.chatProposal;
		replaceMap(cohortEdits, state.cohortEdits);
		replaceMap(messageExceptions, state.messageExceptions);
		messageActionEdits.clear();
		for (const [alias, edits] of state.messageActionEdits) {
			messageActionEdits.set(alias, new Map(edits));
		}
		exclusions.clear();
		for (const alias of state.exclusions) exclusions.add(alias);
		replaceMap(filterEdits, state.filterEdits);
		replaceMap(userTargetEdits.folder, state.userTargetEdits.folder);
		replaceMap(userTargetEdits.label, state.userTargetEdits.label);
		replaceMap(userTargetEdits.filter, state.userTargetEdits.filter);
		dirty = state.dirty;
		announcement = state.announcement;
	};

	return Object.freeze({
		getSnapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async selectChoice(choiceId) {
			if (!choices.has(choiceId)) fail("invalid_edit");
			requireMutableState();
			const end = beginOperation("editing");
			const previous = editorState();
			try {
				await requireUserDecision();
				const accepted = revision.state === "approved";
				selectedChoiceId = choiceId;
				presetSelected = true;
				choiceOverridesChat = true;
				dirty = true;
				const snapshot = getSnapshot();
				const label =
					choiceId === "inbox_zero"
						? "Inbox Zero"
						: `${choiceId[0]?.toUpperCase()}${choiceId.slice(1)}`;
				announcement = `${label} selected. ${snapshot.outcome.archived} messages archived, ${snapshot.outcome.markedRead} marked read, ${snapshot.outcome.review} to Review, 0 deleted.`;
				if (accepted) {
					await persistDraft(operationPlanSnapshot(), true);
				}
			} catch (error) {
				restoreEditorState(previous);
				throw error;
			} finally {
				end();
			}
		},
		async applyEdit(value) {
			const edit = deepFreeze(validateEdit(structuredClone(value)));
			requireMutableState();
			const end = beginOperation("editing");
			const previous = editorState();
			try {
				if (edit.type !== "apply_chat_proposal") {
					await requireUserDecision();
				} else {
					requirePlan();
				}
				const accepted = revision.state === "approved";
				applyValidatedEdit(edit);
				if (accepted || edit.type === "apply_chat_proposal") {
					await persistDraft(
						operationPlanSnapshot(),
						accepted || bindingAvailable,
					);
				}
			} catch (error) {
				restoreEditorState(previous);
				throw error;
			} finally {
				end();
			}
		},
		async saveDraft() {
			requireMutableState();
			const end = beginOperation("saving");
			if (input.capture.inventory.messages.length === 0) {
				end();
				fail("empty_capture");
			}
			try {
				requirePlan();
				if (bindingAvailable) {
					if (
						!(await deps.rawBindings.touch(
							activeBindingScope,
							"user_decision",
						))
					) {
						markBindingExpired();
					} else {
						await refreshBindingStatus();
					}
				}
				requirePlan();
				const saved = await persistDraft(
					operationPlanSnapshot(),
					bindingAvailable,
				);
				announcement = "Draft saved.";
				return saved;
			} finally {
				end();
			}
		},
		async submitToChat() {
			requireMutableState();
			if (revision.state !== "draft") fail("invalid_state");
			const end = beginOperation("submitting");
			if (input.capture.inventory.messages.length === 0) {
				end();
				fail("empty_capture");
			}
			if (input.capture.status !== "complete") {
				end();
				fail("chat_unavailable");
			}
			if (!bridgeIsOpen()) {
				end();
				chatStatus = "error";
				chatMessage =
					"Chat is disconnected. Reconnect before submitting.";
				canReconnect = true;
				notify();
				fail("chat_unavailable");
			}
			let pending: ReturnType<MailboxPlanWorkspaceDeps["bridge"]["submit"]>;
			try {
				await requireUserDecision();
				if (dirty || revision.state !== "draft") {
					await persistDraft(operationPlanSnapshot(), true);
				}
				requirePlan();
				chatStatus = "waiting";
				chatMessage = "Waiting for a mailbox cleanup proposal.";
				canReconnect = false;
				pending = deps.bridge.submit({
					inventory: input.capture.inventory,
					revision,
				});
			} finally {
				end();
			}
			try {
				const result = await pending;
				if (
					result !== null &&
					typeof result === "object" &&
					(result as { status?: unknown }).status === "proposal"
				) {
					await waitForIdle();
					const edit = validateEdit({
						type: "apply_chat_proposal",
						proposal: (result as { proposal: MailboxPlanRevision })
							.proposal,
					});
					const finishProposal = beginOperation("editing");
					const previous = editorState();
					try {
						requirePlan();
						await refreshBindingStatus();
						applyValidatedEdit(edit);
						await persistDraft(
							operationPlanSnapshot(),
							bindingAvailable,
						);
						chatStatus = "proposal";
						chatMessage =
							"Chat proposal applied. Review your cleanup plan before accepting.";
						canReconnect = false;
					} catch (error) {
						restoreEditorState(previous);
						throw error;
					} finally {
						finishProposal();
					}
				} else if (
					result !== null &&
					typeof result === "object" &&
					(result as { status?: unknown }).status === "canceled"
				) {
					chatStatus = "canceled";
					chatMessage = "Chat proposal canceled.";
					canReconnect = false;
					notify();
				} else if (
					result !== null &&
					typeof result === "object" &&
					(result as { status?: unknown }).status === "error"
				) {
					chatStatus = "error";
					chatMessage =
						"Chat could not produce a proposal. Review the plan manually.";
					canReconnect = false;
					notify();
				} else {
					chatStatus = "idle";
					chatMessage = "";
					notify();
				}
				return result;
			} catch (error) {
				const code =
					error !== null && typeof error === "object"
						? (error as { code?: unknown }).code
						: undefined;
				if (code === "timeout" || code === "disconnected") {
					chatStatus = "disconnected";
					chatMessage =
						"Chat disconnected. Reconnect to continue this proposal.";
					canReconnect = true;
				} else {
					chatStatus = "error";
					chatMessage =
						"Chat could not produce a proposal. Review the plan manually.";
					canReconnect = false;
				}
				notify();
				throw error;
			}
		},
		async acceptRevision() {
			if (revision.state === "approved" && !dirty) return revision;
			if (revision.state !== "draft") fail("invalid_state");
			const end = beginOperation("accepting");
			if (input.capture.inventory.messages.length === 0) {
				end();
				fail("empty_capture");
			}
			try {
				await requireUserDecision();
				if (restartRequired) fail("restart_required");
				const draftPlan = operationPlanSnapshot();
				const canonicalActions = validateCanonicalMailboxActions(
					draftPlan.actions.map((action) => ({
						...action,
						schemaVersion: 1,
						actionAlias: deps.createActionAlias(),
					})),
				);
				const plan: OperationPlanSnapshot = Object.freeze({
					...draftPlan,
					// The editor emits only legacy-safe payloads; canonical
					// metadata remains present on the runtime objects.
					actions: canonicalActions as readonly MailboxAction[],
				});
				const fingerprint = await deps.computeFingerprint({
					inventory: input.capture.inventory,
					metadata: input.capture.metadata,
					actions: plan.actions,
					targets: plan.targets,
				});
				requirePlan();
				if (!(await refreshBindingStatus())) fail("binding_expired");
				if (
					dirty ||
					revision.actions.some(
						(action) =>
							!("actionAlias" in action) ||
							!("schemaVersion" in action),
					) ||
					revision.inventoryFingerprint.digest !==
						fingerprint.digest
				) {
					await persistDraft(plan, true, fingerprint);
				}
				requirePlan();
				if (!(await refreshBindingStatus())) fail("binding_expired");
				await deps.lifecycle.transition({
					planAlias: revision.planAlias,
					revisionAlias: revision.revisionAlias,
					expectedState: "draft",
					nextState: "approved",
				});
				revision = frozenRevision(
					validateMailboxPlanRevision({
						...revision,
						state: "approved",
					}),
				);
				dirty = false;
				announcement = "Revision accepted.";
				if (!(await refreshBindingStatus())) {
					fail("binding_expired");
				}
				await deps.startExecution(
					Object.freeze({
						planAlias: revision.planAlias,
						revisionAlias: revision.revisionAlias,
					}),
				);
				announcement = "Revision accepted. Cleanup execution started.";
				return revision;
			} finally {
				end();
			}
		},
		async cancel() {
			if (revision.state === "canceled" || revision.state === "completed") {
				return;
			}
			const end = beginOperation("canceling");
			try {
				requirePlan();
				await deps.bridge.cancel?.();
				requirePlan();
				await deps.lifecycle.transition({
					planAlias: revision.planAlias,
					revisionAlias: revision.revisionAlias,
					expectedState: revision.state,
					nextState: "canceled",
				});
				revision = frozenRevision(
					validateMailboxPlanRevision({
						...revision,
						state: "canceled",
					}),
				);
				dirty = false;
				announcement = "Cleanup canceled.";
			} finally {
				end();
			}
		},
		async reconnectChat() {
			if (!canReconnect || deps.bridge.reconnect === undefined) {
				fail("invalid_state");
			}
			const end = beginOperation("reconnecting");
			try {
				requirePlan();
				chatStatus = "reconnecting";
				chatMessage = "Reconnecting to chat.";
				await deps.bridge.reconnect();
				requirePlan();
				chatStatus = "waiting";
				chatMessage = "Chat reconnected. Ready to submit.";
				canReconnect = false;
			} finally {
				end();
			}
		},
		async refreshStatus() {
			const end = beginOperation("editing");
			try {
				requirePlan();
				await refreshBindingStatus();
			} finally {
				end();
			}
		},
	});
}
