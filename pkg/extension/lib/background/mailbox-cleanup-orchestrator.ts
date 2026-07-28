import {
	type MailboxAction,
	type MailboxCanonicalAction,
	validateMailboxPlanRevision,
	type MailboxFingerprint,
	type MailboxPlanRevision,
} from "@dg/common";
import type {
	MailboxChatMarker,
	MailboxChatSubmitMessage,
	MailboxChatSubmitResult,
	MailboxRuntimeChatReceiver,
	MailboxRuntimeProposalFingerprintInput,
} from "../features/mailbox-cleanup/bridge";
import {
	createMailboxCaptureCoordinator,
	type MailboxCaptureRequest,
	type MailboxCaptureResult,
} from "../features/mailbox-cleanup/coordinator";
import {
	computeMailboxScopedFingerprint,
} from "../features/mailbox-cleanup/planning";
import {
	buildMailboxExecutionAuthorityScope,
	validateCanonicalMailboxExecutionRevision,
} from "../features/mailbox-cleanup/execution/graph";
import { mailboxExecutionRawTargets } from "../features/mailbox-cleanup/execution/coordinator";
import type {
	MailboxProvider,
	MailboxProviderCaptureRequest,
} from "../features/mailbox-cleanup/providers";
import { createGuardedMailboxExecutionProvider } from "../features/mailbox-cleanup/providers";
import {
	type RawBindingScope,
	type RawBindingStore,
	type SessionStorageSeam,
} from "../features/mailbox-cleanup/storage";
import {
	writeAndOpenMailboxPlan,
	type MailboxPlanWorkspaceInput,
} from "../features/mailbox-cleanup/plan-page";
import type {
	MailboxPlanBindingContext,
	MailboxPlanRestartAuthority,
	MailboxPlanRestartCapture,
	MailboxPlanRestartCheckpoint,
} from "../features/mailbox-cleanup/plan-workspace/list";

const BINDING_TTL_MS = 60 * 60 * 1_000;
const PLAN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

type BrowserPlanHost = Readonly<{
	runtime: Readonly<{ getURL(path: string): string }>;
	tabs: Readonly<{
		create(value: Readonly<{ url: string }>): Promise<unknown>;
	}>;
}>;

export type MailboxProductionOrchestrator = Readonly<{
	launch(): Promise<MailboxChatSubmitResult>;
	openRevision(
		revision: MailboxPlanRevision,
		context: MailboxPlanBindingContext,
	): Promise<void>;
	preflightRevision(
		revision: MailboxPlanRevision,
		context: MailboxPlanBindingContext,
	): Promise<
		| Readonly<{ status: "ready"; fingerprintMatches: true }>
		| Readonly<{
				status: "blocked";
				reason:
					| "fingerprint_mismatch"
					| "account_mismatch"
					| "layout_mismatch"
					| "preflight_failed";
		  }>
	>;
	restartCapture(input: Readonly<{
		sourceRevision: MailboxPlanRevision;
		sourceContext: MailboxPlanBindingContext;
		previousBindings?: Readonly<Record<string, string>>;
		checkpoints: readonly MailboxPlanRestartCheckpoint[];
		comparisonAuthority?: MailboxPlanRestartAuthority;
		signal: AbortSignal;
	}>): Promise<MailboxPlanRestartCapture>;
	computeFingerprint(
		input: Readonly<Record<string, unknown>>,
	): Promise<MailboxFingerprint>;
	refingerprintProposal(
		input: MailboxRuntimeProposalFingerprintInput,
	): Promise<MailboxPlanRevision>;
	chatReceiver: MailboxRuntimeChatReceiver;
}>;

function randomToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function selectedProvider(
	providers: readonly MailboxProvider[],
	scope?: Readonly<{ providerId: string; surface: string }>,
): Readonly<{ provider: MailboxProvider; surface: string }> {
	const candidates =
		scope === undefined
			? providers.flatMap((provider) =>
					provider.surfaces.map((surface) => ({ provider, surface })),
				)
			: providers
					.filter((provider) => provider.id === scope.providerId)
					.flatMap((provider) =>
						provider.surfaces
							.filter((surface) => surface === scope.surface)
							.map((surface) => ({ provider, surface })),
					);
	if (candidates.length !== 1) {
		throw Object.freeze({ reasonCode: "provider_refused" as const });
	}
	return Object.freeze(candidates[0]!);
}

function scopedAlias(prefix: "acct" | "run" | "rev" | "plan"): string {
	return `${prefix}_${randomToken()}`;
}

function dataAlias(prefix: "msg" | "fld" | "lbl" | "flt"): string {
	return `${prefix}_${randomToken()}`;
}

type SuccessfulCapture = Extract<
	MailboxCaptureResult,
	{ status: "complete" | "partial" }
>;

async function coordinatorCapture(
	provider: MailboxProvider,
	scope: MailboxProviderCaptureRequest,
	now: () => number,
): Promise<SuccessfulCapture> {
	const coordinator = createMailboxCaptureCoordinator({
		provider: provider.coordinator,
		now: () => new Date(now()).toISOString(),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			coordinator.cancel();
			reject(Object.freeze({ reasonCode: "provider_timeout" as const }));
		}, 30_000);
	});
	try {
		const result = await Promise.race([
			coordinator.start({
				schemaVersion: 1,
				...scope,
				bodyMessageAliases: Object.freeze([]),
			} satisfies MailboxCaptureRequest),
			timeout,
		]);
		if (result.status !== "complete" && result.status !== "partial") {
			throw Object.freeze({ reasonCode: result.reasonCode });
		}
		return result;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function exactBindings(
	capture: SuccessfulCapture,
	value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const expected = new Set([
		...capture.inventory.messages.map((item) => item.alias),
		...capture.inventory.folders.map((item) => item.alias),
		...capture.inventory.labels.map((item) => item.alias),
		...capture.inventory.filters.map((item) => item.alias),
		...capture.metadata.tags.map((item) => item.alias),
		...capture.metadata.categories.map((item) => item.alias),
	]);
	if (
		Object.keys(value).length !== expected.size ||
		Object.keys(value).some((alias) => !expected.has(alias))
	) {
		throw Object.freeze({ reasonCode: "stale_binding" as const });
	}
	return Object.freeze({ ...value });
}

function currentCaptureBindings(
	capture: SuccessfulCapture,
	value: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const aliases = [
		...capture.inventory.messages.map((item) => item.alias),
		...capture.inventory.folders.map((item) => item.alias),
		...capture.inventory.labels.map((item) => item.alias),
		...capture.inventory.filters.map((item) => item.alias),
		...capture.metadata.tags.map((item) => item.alias),
		...capture.metadata.categories.map((item) => item.alias),
	];
	const projected: Record<string, string> = {};
	for (const alias of aliases) {
		const raw = value[alias];
		if (typeof raw !== "string") {
			throw Object.freeze({ reasonCode: "stale_binding" as const });
		}
		projected[alias] = raw;
	}
	return Object.freeze(projected);
}

function capturedBindingsOnly(
	capture: SuccessfulCapture,
	bindings: Readonly<Record<string, string>>,
	capturedBindings: Readonly<Record<string, string>>,
): SuccessfulCapture {
	const aliasByRaw = new Map<string, string>();
	for (const [alias, raw] of Object.entries(bindings)) {
		if (aliasByRaw.has(raw)) {
			throw Object.freeze({ reasonCode: "stale_binding" as const });
		}
		aliasByRaw.set(raw, alias);
	}
	const capturedToBound = new Map<string, string>();
	for (const [alias, raw] of Object.entries(capturedBindings)) {
		const boundAlias = aliasByRaw.get(raw);
		if (
			boundAlias !== undefined &&
			alias.slice(0, alias.indexOf("_")) ===
				boundAlias.slice(0, boundAlias.indexOf("_"))
		) {
			capturedToBound.set(alias, boundAlias);
		}
	}
	const rebound = remapCapture(capture, capturedToBound);
	const retained = <Item extends Readonly<{ alias: string }>>(
		items: readonly Item[],
	): readonly Item[] =>
		Object.freeze(
			items.filter((item) => Object.hasOwn(bindings, item.alias)),
		);
	return Object.freeze({
		...rebound,
		inventory: Object.freeze({
			...rebound.inventory,
			messages: retained(rebound.inventory.messages),
			folders: retained(rebound.inventory.folders),
			labels: retained(rebound.inventory.labels),
			filters: retained(rebound.inventory.filters),
		}),
		metadata: Object.freeze({
			tags: retained(rebound.metadata.tags),
			categories: retained(rebound.metadata.categories),
		}),
	});
}

async function coordinatorBindings(
	provider: MailboxProvider,
	scope: MailboxProviderCaptureRequest,
): Promise<Readonly<Record<string, string>>> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(Object.freeze({ reasonCode: "provider_timeout" as const }));
		}, 30_000);
	});
	try {
		return await Promise.race([
			provider.coordinator.bindings(scope, controller.signal),
			timeout,
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function safeError(): MailboxChatSubmitResult {
	return Object.freeze({ status: "error", code: "provider_refused" });
}

function actionAliases(
	action: MailboxAction,
	map: ReadonlyMap<string, string>,
): MailboxAction;
function actionAliases(
	action: MailboxCanonicalAction,
	map: ReadonlyMap<string, string>,
): MailboxCanonicalAction;
function actionAliases(
	action: MailboxAction | MailboxCanonicalAction,
	map: ReadonlyMap<string, string>,
): MailboxAction | MailboxCanonicalAction {
	const alias = (value: string): string => map.get(value) ?? value;
	switch (action.type) {
		case "archive":
		case "mark_read":
			return Object.freeze({
				...action,
				messageAlias: alias(action.messageAlias),
			});
		case "move_to_folder":
			return Object.freeze({
				...action,
				messageAlias: alias(action.messageAlias),
				folderAlias: alias(action.folderAlias),
			});
		case "apply_label":
		case "remove_label":
			return Object.freeze({
				...action,
				messageAlias: alias(action.messageAlias),
				labelAlias: alias(action.labelAlias),
			});
		case "deactivate_filter":
			return Object.freeze({
				...action,
				filterAlias: alias(action.filterAlias),
			});
		case "create_folder":
			return Object.freeze({
				...action,
				folderAlias: alias(action.folderAlias),
			});
		case "rename_folder":
			return Object.freeze({
				...action,
				folderAlias: alias(action.folderAlias),
				replacementFolderAlias: alias(action.replacementFolderAlias),
			});
		case "create_label":
		case "create_category":
			return Object.freeze({
				...action,
				labelAlias: alias(action.labelAlias),
			});
		case "rename_label":
		case "rename_category":
			return Object.freeze({
				...action,
				labelAlias: alias(action.labelAlias),
				replacementLabelAlias: alias(action.replacementLabelAlias),
			});
		case "apply_category":
			return Object.freeze({
				...action,
				messageAlias: alias(action.messageAlias),
				labelAlias: alias(action.labelAlias),
			});
		case "create_filter":
			return Object.freeze({
				...action,
				filterAlias: alias(action.filterAlias),
			});
		case "change_filter":
			return Object.freeze({
				...action,
				filterAlias: alias(action.filterAlias),
				replacementFilterAlias: alias(action.replacementFilterAlias),
			});
	}
}

function revisionAliases(
	source: MailboxPlanRevision,
	map: ReadonlyMap<string, string>,
	revisionAlias: string,
	createdAt: string,
	fingerprint: MailboxFingerprint,
): MailboxPlanRevision {
	const alias = (value: string): string => map.get(value) ?? value;
	return validateMailboxPlanRevision({
		...source,
		revisionAlias,
		revisionNumber: source.revisionNumber + 1,
		state: "draft",
		restartRequired: false,
		createdAt,
		inventoryFingerprint: fingerprint,
		cohorts: source.cohorts.map((cohort) => ({
			...cohort,
			messageAliases: cohort.messageAliases.map(alias),
			suggestedActions: cohort.suggestedActions.map((action) =>
				actionAliases(action, map),
			),
		})),
		targets: {
			folderAliases: source.targets.folderAliases.map(alias).sort(),
			labelAliases: source.targets.labelAliases.map(alias).sort(),
			filterAliases: source.targets.filterAliases.map(alias).sort(),
		},
		actions: source.actions.map((action) => actionAliases(action, map)),
	});
}

function referencedAliases(revision: MailboxPlanRevision): readonly string[] {
	const values = new Set<string>([
		...revision.cohorts.flatMap((cohort) => cohort.messageAliases),
		...revision.targets.folderAliases,
		...revision.targets.labelAliases,
		...revision.targets.filterAliases,
	]);
	for (const action of [
		...revision.actions,
		...revision.cohorts.flatMap((cohort) => cohort.suggestedActions),
	]) {
		for (const [key, value] of Object.entries(action)) {
			if (
				key.endsWith("Alias") &&
				key !== "actionAlias" &&
				typeof value === "string"
			) {
				values.add(value);
			}
		}
	}
	return Object.freeze([...values]);
}

function comparisonCapture(
	capture: SuccessfulCapture,
	freshToPrior: ReadonlyMap<string, string>,
): SuccessfulCapture {
	const items = <Item extends Readonly<{ alias: string }>>(
		values: readonly Item[],
	): readonly Item[] =>
		Object.freeze(
			values.flatMap((item) => {
				const alias = freshToPrior.get(item.alias);
				return alias === undefined
					? []
					: [Object.freeze({ ...item, alias }) as Item];
			}),
		);
	return Object.freeze({
		...capture,
		inventory: Object.freeze({
			...capture.inventory,
			messages: items(capture.inventory.messages),
			folders: items(capture.inventory.folders),
			labels: items(capture.inventory.labels),
			filters: items(capture.inventory.filters),
		}),
		metadata: Object.freeze({
			tags: items(capture.metadata.tags),
			categories: items(capture.metadata.categories),
		}),
		cohorts: Object.freeze(
			capture.cohorts.map((cohort) =>
				Object.freeze({
					...cohort,
					messageAliases: Object.freeze(
						cohort.messageAliases.map(
							(alias) => freshToPrior.get(alias) ?? alias,
						),
					),
					suggestedActions: Object.freeze(
						cohort.suggestedActions.map((action) =>
							actionAliases(action, freshToPrior),
						),
					),
				}),
			),
		),
		choices: Object.freeze(
			capture.choices.map((choice) =>
				Object.freeze({
					...choice,
					actions: Object.freeze(
						choice.actions.map((action) =>
							actionAliases(action, freshToPrior),
						),
					),
					reviewMessageAliases: Object.freeze(
						choice.reviewMessageAliases.map(
							(alias) => freshToPrior.get(alias) ?? alias,
						),
					),
					metadata: Object.freeze({
						tagAliases: Object.freeze(
							choice.metadata.tagAliases.map(
								(alias) =>
									freshToPrior.get(alias) ?? alias,
							),
						),
						categoryAliases: Object.freeze(
							choice.metadata.categoryAliases.map(
								(alias) =>
									freshToPrior.get(alias) ?? alias,
							),
						),
					}),
				}),
			),
		),
	});
}

function remapCapture(
	capture: SuccessfulCapture,
	aliases: ReadonlyMap<string, string>,
): SuccessfulCapture {
	const items = <Item extends Readonly<{ alias: string }>>(
		values: readonly Item[],
	): readonly Item[] =>
		Object.freeze(
			values.map(
				(item) =>
					Object.freeze({
						...item,
						alias: aliases.get(item.alias) ?? item.alias,
					}) as Item,
			),
		);
	return Object.freeze({
		...capture,
		inventory: Object.freeze({
			...capture.inventory,
			messages: items(capture.inventory.messages),
			folders: items(capture.inventory.folders),
			labels: items(capture.inventory.labels),
			filters: items(capture.inventory.filters),
		}),
		metadata: Object.freeze({
			tags: items(capture.metadata.tags),
			categories: items(capture.metadata.categories),
		}),
		cohorts: Object.freeze(
			capture.cohorts.map((cohort) =>
				Object.freeze({
					...cohort,
					messageAliases: Object.freeze(
						cohort.messageAliases.map(
							(alias) => aliases.get(alias) ?? alias,
						),
					),
					suggestedActions: Object.freeze(
						cohort.suggestedActions.map((action) =>
							actionAliases(action, aliases),
						),
					),
				}),
			),
		),
		choices: Object.freeze(
			capture.choices.map((choice) =>
				Object.freeze({
					...choice,
					actions: Object.freeze(
						choice.actions.map((action) =>
							actionAliases(action, aliases),
						),
					),
					reviewMessageAliases: Object.freeze(
						choice.reviewMessageAliases.map(
							(alias) => aliases.get(alias) ?? alias,
						),
					),
					metadata: Object.freeze({
						tagAliases: Object.freeze(
							choice.metadata.tagAliases.map(
								(alias) => aliases.get(alias) ?? alias,
							),
						),
						categoryAliases: Object.freeze(
							choice.metadata.categoryAliases.map(
								(alias) => aliases.get(alias) ?? alias,
							),
						),
					}),
				}),
			),
		),
	});
}

export function createMailboxProductionOrchestrator(options: Readonly<{
	providers: readonly MailboxProvider[];
	session: SessionStorageSeam;
	bindings: RawBindingStore;
	browser: BrowserPlanHost;
	now(): number;
	authorChat?(
		message: MailboxChatSubmitMessage,
	): Promise<MailboxChatSubmitResult>;
	cancelChat?(): Promise<void>;
	closeChat?(): Promise<void> | void;
}>): MailboxProductionOrchestrator {
	const metadataByPlan = new Map<
		string,
		SuccessfulCapture["metadata"]
	>();
	const launch = async (): Promise<MailboxChatSubmitResult> => {
		try {
			const { provider, surface } = selectedProvider(options.providers);
			const accountAlias = scopedAlias("acct");
			const runAlias = scopedAlias("run");
			const revisionAlias = scopedAlias("rev");
			const providerScope = Object.freeze({
				providerId: provider.id,
				surface,
				accountAlias,
				runAlias,
				revisionAlias,
			});
			const planAlias = scopedAlias("plan");
			const capture = await coordinatorCapture(
				provider,
				providerScope,
				options.now,
			);
			const capturedAt = capture.inventory.capturedAt;
			const {
				inventory,
				metadata: captureMetadata,
				cohorts,
				choices,
			} = capture;
			const selected =
				choices.find((choice) => choice.id === "balanced") ??
				choices[0];
			if (selected === undefined) {
				throw Object.freeze({ reasonCode: "provider_refused" as const });
			}
			const targets = Object.freeze({
				folderAliases: Object.freeze(
					inventory.folders.map((item) => item.alias),
				),
				labelAliases: Object.freeze(
					inventory.labels.map((item) => item.alias),
				),
				filterAliases: Object.freeze(
					inventory.filters.map((item) => item.alias),
				),
			});
			const fingerprint = await computeMailboxScopedFingerprint({
				inventory,
				metadata: captureMetadata,
				actions: selected.actions,
				targets,
			});
			const proposal = validateMailboxPlanRevision({
				schemaVersion: 1,
				planAlias,
				revisionAlias,
				revisionNumber: 1,
				state: "draft",
				restartRequired: false,
				createdAt: capturedAt,
				inventoryFingerprint: fingerprint,
				cohorts,
				targets,
				actions: selected.actions,
			});
			const bindingScope: RawBindingScope = Object.freeze({
				planAlias,
				...providerScope,
			});
			await options.bindings.put(
				bindingScope,
				exactBindings(
					capture,
					await coordinatorBindings(provider, providerScope),
				),
			);
			const now = options.now();
			const input: MailboxPlanWorkspaceInput = Object.freeze({
				capture,
				baseRevision: proposal,
				bindingScope,
				bindingExpiresAt: now + BINDING_TTL_MS,
				planExpiresAt: now + PLAN_TTL_MS,
			});
			await writeAndOpenMailboxPlan(input, {
				session: options.session,
				runtime: options.browser.runtime,
				tabs: options.browser.tabs,
				computeFingerprint: computeMailboxScopedFingerprint,
			});
			metadataByPlan.set(planAlias, captureMetadata);
			return Object.freeze({ status: "proposal", proposal });
		} catch {
			return safeError();
		}
	};

	const openRevision = async (
		revisionValue: MailboxPlanRevision,
		context: MailboxPlanBindingContext,
	): Promise<void> => {
		const revision = validateMailboxPlanRevision(revisionValue);
		const { provider } = selectedProvider(options.providers, context);
		const providerScope: MailboxProviderCaptureRequest = Object.freeze({
			providerId: context.providerId,
			surface: context.surface,
			accountAlias: context.accountAlias,
			runAlias: context.runAlias,
			revisionAlias: context.revisionAlias,
		});
		const freshCapture = await coordinatorCapture(
			provider,
			providerScope,
			options.now,
		);
		const raw = await options.bindings.get({
			planAlias: context.planAlias,
			...providerScope,
		});
		if (raw === undefined) {
			throw Object.freeze({ reasonCode: "stale_binding" as const });
		}
		const freshBindings = exactBindings(
			freshCapture,
			await coordinatorBindings(provider, providerScope),
		);
		const priorByRaw = new Map(
			Object.entries(raw).map(([alias, value]) => [value, alias]),
		);
		const freshToPrior = new Map(
			Object.entries(freshBindings).flatMap(([alias, value]) => {
				const prior = priorByRaw.get(value);
				return prior === undefined ? [] : [[alias, prior] as const];
			}),
		);
		const capture = comparisonCapture(freshCapture, freshToPrior);
		const currentFingerprint = await computeMailboxScopedFingerprint({
			inventory: capture.inventory,
			metadata: capture.metadata,
			actions: revision.actions,
			targets: revision.targets,
		});
		if (
			currentFingerprint.digest !== revision.inventoryFingerprint.digest
		) {
			throw Object.freeze({ reasonCode: "stale_binding" as const });
		}
		const now = options.now();
		await writeAndOpenMailboxPlan(
			Object.freeze({
				capture,
				baseRevision: revision,
				bindingScope: Object.freeze({
					planAlias: context.planAlias,
					...providerScope,
				}),
				bindingExpiresAt: now + BINDING_TTL_MS,
				planExpiresAt: now + PLAN_TTL_MS,
			}),
			{
				session: options.session,
				runtime: options.browser.runtime,
				tabs: options.browser.tabs,
				computeFingerprint: computeMailboxScopedFingerprint,
			},
		);
	};

	const preflightRevision = async (
		revisionValue: MailboxPlanRevision,
		context: MailboxPlanBindingContext,
	): ReturnType<MailboxProductionOrchestrator["preflightRevision"]> => {
		const revision = validateMailboxPlanRevision(revisionValue);
		const { provider } = selectedProvider(options.providers, context);
		const raw = await options.bindings.get({
			planAlias: context.planAlias,
			providerId: context.providerId,
			surface: context.surface,
			accountAlias: context.accountAlias,
			runAlias: context.runAlias,
			revisionAlias: context.revisionAlias,
		});
		if (raw === undefined) {
			return Object.freeze({
				status: "blocked",
				reason: "preflight_failed",
			});
		}
		const providerScope: MailboxProviderCaptureRequest = Object.freeze({
			providerId: context.providerId,
			surface: context.surface,
			accountAlias: context.accountAlias,
			runAlias: context.runAlias,
			revisionAlias: context.revisionAlias,
		});
		const freshCapture = await coordinatorCapture(
			provider,
			providerScope,
			options.now,
		);
		const freshBindings = exactBindings(
			freshCapture,
			await coordinatorBindings(provider, providerScope),
		);
		const priorByRaw = new Map(
			Object.entries(raw).map(([alias, value]) => [value, alias]),
		);
		const freshToPrior = new Map(
			Object.entries(freshBindings).flatMap(([alias, value]) => {
				const prior = priorByRaw.get(value);
				return prior === undefined ? [] : [[alias, prior] as const];
			}),
		);
		const capture = comparisonCapture(freshCapture, freshToPrior);
		const fingerprint = await computeMailboxScopedFingerprint({
			inventory: capture.inventory,
			metadata: capture.metadata,
			actions: revision.actions,
			targets: revision.targets,
		});
		if (fingerprint.digest !== revision.inventoryFingerprint.digest) {
			return Object.freeze({
				status: "blocked",
				reason: "fingerprint_mismatch",
			});
		}
		const executionRevision =
			validateCanonicalMailboxExecutionRevision(revision);
		const result = await createGuardedMailboxExecutionProvider(
			provider,
		).preflight({
			providerId: context.providerId,
			surface: context.surface,
			accountAlias: context.accountAlias,
			runAlias: context.runAlias,
			revisionAlias: context.revisionAlias,
			actions: executionRevision.actions,
			rawTargets: mailboxExecutionRawTargets(
				executionRevision.actions,
				raw,
			),
		});
		if (result.status !== "ready") {
			return Object.freeze({
				status: "blocked",
				reason: "preflight_failed",
			});
		}
		if (result.accountAlias !== context.accountAlias) {
			return Object.freeze({
				status: "blocked",
				reason: "account_mismatch",
			});
		}
		if (result.locale !== "en-US" || result.layout !== "supported") {
			return Object.freeze({
				status: "blocked",
				reason: "layout_mismatch",
			});
		}
		return Object.freeze({
			status: "ready",
			fingerprintMatches: true,
		});
	};

	const restartCapture = async (
		input: Parameters<MailboxProductionOrchestrator["restartCapture"]>[0],
	): Promise<MailboxPlanRestartCapture> => {
		if (input.signal.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		const source = validateMailboxPlanRevision(input.sourceRevision);
		const { provider } = selectedProvider(
			options.providers,
			input.sourceContext,
		);
		const providerScope: MailboxProviderCaptureRequest = Object.freeze({
			providerId: input.sourceContext.providerId,
			surface: input.sourceContext.surface,
			accountAlias: input.sourceContext.accountAlias,
			runAlias: scopedAlias("run"),
			revisionAlias: scopedAlias("rev"),
		});
		const providerCapture = await coordinatorCapture(
			provider,
			providerScope,
			options.now,
		);
		if (input.signal.aborted) {
			throw new DOMException("Aborted", "AbortError");
		}
		const providerBindings = currentCaptureBindings(
			providerCapture,
			await coordinatorBindings(provider, providerScope),
		);
		const providerToFresh = new Map(
			Object.keys(providerBindings).map((alias) => {
				const prefix = alias.slice(0, alias.indexOf("_"));
				if (
					prefix !== "msg" &&
					prefix !== "fld" &&
					prefix !== "lbl" &&
					prefix !== "flt"
				) {
					throw Object.freeze({
						reasonCode: "stale_binding" as const,
					});
				}
				return [alias, dataAlias(prefix)] as const;
			}),
		);
		const capture = remapCapture(providerCapture, providerToFresh);
		const bindings = Object.freeze(
			Object.fromEntries(
				Object.entries(providerBindings).map(([alias, raw]) => [
					providerToFresh.get(alias)!,
					raw,
				]),
			),
		);
		if (input.previousBindings === undefined) {
			const selected =
				capture.choices.find((choice) => choice.id === "balanced") ??
				capture.choices[0];
			if (selected === undefined) {
				throw Object.freeze({
					reasonCode: "provider_refused" as const,
				});
			}
			const targets = Object.freeze({
				folderAliases: Object.freeze(
					capture.inventory.folders.map((item) => item.alias).sort(),
				),
				labelAliases: Object.freeze(
					[
						...capture.inventory.labels.map((item) => item.alias),
						...capture.metadata.tags.map((item) => item.alias),
						...capture.metadata.categories.map(
							(item) => item.alias,
						),
					].sort(),
				),
				filterAliases: Object.freeze(
					capture.inventory.filters.map((item) => item.alias).sort(),
				),
			});
			const fingerprint = await computeMailboxScopedFingerprint(
				{
					inventory: capture.inventory,
					metadata: capture.metadata,
					actions: selected.actions,
					targets,
				},
				input.signal,
			);
			const locale = await provider.readLocale();
			const supportedLayout =
				await provider.hasPositiveLayoutSignature(
					providerScope.surface,
				);
			const sameAccount =
				capture.inventory.accountAlias === providerScope.accountAlias;
			const ready =
				sameAccount &&
				(Array.isArray(locale)
					? locale.length === 1 && locale[0] === "en-US"
					: locale === "en-US") &&
				supportedLayout;
			return Object.freeze({
				schemaVersion: 1,
				revision: validateMailboxPlanRevision({
					...source,
					revisionAlias: providerScope.revisionAlias,
					revisionNumber: source.revisionNumber + 1,
					state: "draft",
					restartRequired: false,
					createdAt: capture.inventory.capturedAt,
					inventoryFingerprint: fingerprint,
					cohorts: capture.cohorts,
					targets,
					actions: selected.actions,
				}),
				context: Object.freeze({
					schemaVersion: 1,
					planAlias: source.planAlias,
					...providerScope,
				}),
				bindings,
				priorToFreshAliases: Object.freeze({}),
				proof: Object.freeze({
					sameAccount,
					locale: "en-US",
					layout: supportedLayout
						? "supported"
						: "unsupported",
					preflight: ready ? "ready" : "blocked",
				}),
			});
		}
		const freshByRaw = new Map<string, string>();
		for (const [alias, raw] of Object.entries(bindings)) {
			if (freshByRaw.has(raw)) {
				throw Object.freeze({ reasonCode: "stale_binding" as const });
			}
			freshByRaw.set(raw, alias);
		}
		const priorToFresh = new Map<string, string>();
		for (const [priorAlias, raw] of Object.entries(
			input.previousBindings,
		)) {
			const freshAlias = freshByRaw.get(raw);
			if (freshAlias !== undefined) {
				priorToFresh.set(priorAlias, freshAlias);
			}
		}
		for (const priorAlias of referencedAliases(source)) {
			if (priorToFresh.has(priorAlias)) continue;
			const prefix = priorAlias.slice(0, priorAlias.indexOf("_"));
			if (
				prefix !== "msg" &&
				prefix !== "fld" &&
				prefix !== "lbl" &&
				prefix !== "flt"
			) {
				throw Object.freeze({ reasonCode: "stale_binding" as const });
			}
			priorToFresh.set(priorAlias, dataAlias(prefix));
		}
		const terminalActionAliases = new Set(
			input.checkpoints
				.filter(
					(checkpoint) =>
						checkpoint.state === "verified" ||
						checkpoint.state === "skipped",
				)
				.map((checkpoint) => checkpoint.actionAlias),
		);
		const aliasedSource = revisionAliases(
			source,
			priorToFresh,
			providerScope.revisionAlias,
			capture.inventory.capturedAt,
			source.inventoryFingerprint,
		);
		const candidateWithPriorFingerprint = validateMailboxPlanRevision({
			...aliasedSource,
			actions: aliasedSource.actions.filter(
				(action) =>
					!("actionAlias" in action) ||
					typeof action.actionAlias !== "string" ||
					!terminalActionAliases.has(action.actionAlias),
			),
		});
		const candidateFingerprint = await computeMailboxScopedFingerprint(
			{
				inventory: capture.inventory,
				metadata: capture.metadata,
				actions: candidateWithPriorFingerprint.actions,
				targets: candidateWithPriorFingerprint.targets,
			},
			input.signal,
		);
		const candidate = validateMailboxPlanRevision({
			...candidateWithPriorFingerprint,
			inventoryFingerprint: candidateFingerprint,
		});
		const freshToPrior = new Map(
			[...priorToFresh].map(([prior, fresh]) => [fresh, prior]),
		);
		let comparisonFingerprint: MailboxFingerprint;
		try {
			const priorCapture = comparisonCapture(capture, freshToPrior);
			const comparisonActions =
				input.comparisonAuthority === undefined
					? source.actions
					: input.comparisonAuthority.scope.actionAliases.map(
							(alias) => {
								const action = source.actions.find(
									(candidate) =>
										"actionAlias" in candidate &&
										candidate.actionAlias === alias,
								);
								if (action === undefined) {
									throw Object.freeze({
										reasonCode: "stale_binding" as const,
									});
								}
								return action;
							},
						);
			comparisonFingerprint = await computeMailboxScopedFingerprint(
				{
					inventory: priorCapture.inventory,
					metadata: priorCapture.metadata,
					actions: comparisonActions,
					targets:
						input.comparisonAuthority?.scope.targets ??
						source.targets,
				},
				input.signal,
			);
		} catch {
			if (input.signal.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}
			comparisonFingerprint = candidateFingerprint;
		}
		const locale = await provider.readLocale();
		const supportedLayout = await provider.hasPositiveLayoutSignature(
			providerScope.surface,
		);
		let sameAccount = false;
		let ready = false;
		if (
			source.state !== "draft" &&
			(Array.isArray(locale)
				? locale.length === 1 && locale[0] === "en-US"
				: locale === "en-US") &&
			supportedLayout
		) {
			const executionRevision =
				validateCanonicalMailboxExecutionRevision({
					...candidate,
					state: "approved",
				});
			const preflight = await createGuardedMailboxExecutionProvider(
				provider,
			).preflight(
				{
					...providerScope,
					actions: executionRevision.actions,
					rawTargets: mailboxExecutionRawTargets(
						executionRevision.actions,
						bindings,
					),
				},
				{ signal: input.signal },
			);
			sameAccount =
				preflight.status === "ready" &&
				preflight.accountAlias === providerScope.accountAlias;
			ready =
				preflight.status === "ready" &&
				preflight.locale === "en-US" &&
				preflight.layout === "supported" &&
				sameAccount;
		} else if (source.state === "draft") {
			sameAccount = capture.inventory.accountAlias === providerScope.accountAlias;
			ready =
				sameAccount &&
				(Array.isArray(locale)
					? locale.length === 1 && locale[0] === "en-US"
					: locale === "en-US") &&
				supportedLayout;
		}
		return Object.freeze({
			schemaVersion: 1,
			comparisonFingerprint,
			revision: candidate,
			context: Object.freeze({
				schemaVersion: 1,
				planAlias: source.planAlias,
				...providerScope,
			}),
			bindings,
			priorToFreshAliases: Object.freeze(
				Object.fromEntries(priorToFresh),
			),
			proof: Object.freeze({
				sameAccount,
				locale: "en-US",
				layout: supportedLayout ? "supported" : "unsupported",
				preflight: ready ? "ready" : "blocked",
			}),
		});
	};

	const computeFingerprint = async (
		value: Readonly<Record<string, unknown>>,
	): Promise<MailboxFingerprint> => {
		const revision = validateCanonicalMailboxExecutionRevision(
			value.revision,
		);
		const authorityScope = value.authorityScope;
		if (
			authorityScope === null ||
			typeof authorityScope !== "object" ||
			Array.isArray(authorityScope)
		) {
			throw new Error("Mailbox execution authority scope is unavailable");
		}
		const actionAliases = (
			authorityScope as { actionAliases?: unknown }
		).actionAliases;
		if (!Array.isArray(actionAliases)) {
			throw new Error("Mailbox execution authority scope is invalid");
		}
		const actionsByAlias = new Map(
			revision.actions.map((action) => [action.actionAlias, action]),
		);
		const actions = actionAliases.map((alias) => {
			if (typeof alias !== "string") {
				throw new Error("Mailbox execution authority scope is invalid");
			}
			const action = actionsByAlias.get(alias);
			if (action === undefined) {
				throw new Error("Mailbox execution authority scope is invalid");
			}
			return action;
		});
		const expectedScope =
			buildMailboxExecutionAuthorityScope(actions);
		if (
			JSON.stringify(authorityScope) !==
			JSON.stringify(expectedScope)
		) {
			throw new Error("Mailbox execution authority scope is invalid");
		}
		const inputScope = value.scope as MailboxProviderCaptureRequest;
		const bindings = value.bindings as Readonly<Record<string, string>>;
		const { provider } = selectedProvider(options.providers, inputScope);
		const scope: MailboxProviderCaptureRequest = Object.freeze({
			providerId: inputScope.providerId,
			surface: inputScope.surface,
			accountAlias: inputScope.accountAlias,
			runAlias: inputScope.runAlias,
			revisionAlias: inputScope.revisionAlias,
		});
		const providerCapture = await coordinatorCapture(
			provider,
			scope,
			options.now,
		);
		const capture = capturedBindingsOnly(
			providerCapture,
			bindings,
			currentCaptureBindings(
				providerCapture,
				await coordinatorBindings(provider, scope),
			),
		);
		return computeMailboxScopedFingerprint({
			inventory: capture.inventory,
			metadata: capture.metadata,
			actions,
			targets: expectedScope.targets,
		});
	};

	const refingerprintProposal = async (
		value: MailboxRuntimeProposalFingerprintInput,
	): Promise<MailboxPlanRevision> => {
		const submitted = validateMailboxPlanRevision(
			structuredClone(value.submittedRevision),
		);
		const proposal = validateMailboxPlanRevision(
			structuredClone(value.proposal),
		);
		const metadata = metadataByPlan.get(submitted.planAlias);
		if (
			metadata === undefined ||
			submitted.state !== "draft" ||
			proposal.state !== "draft" ||
			proposal.planAlias !== submitted.planAlias ||
			proposal.revisionAlias !== submitted.revisionAlias ||
			proposal.revisionNumber !== submitted.revisionNumber ||
			proposal.createdAt !== submitted.createdAt
		) {
			throw new Error("Mailbox chat proposal authority changed");
		}
		const submittedFingerprint = await computeMailboxScopedFingerprint({
			inventory: value.inventory,
			metadata,
			actions: submitted.actions,
			targets: submitted.targets,
		});
		if (
			submittedFingerprint.digest !==
			submitted.inventoryFingerprint.digest
		) {
			throw new Error("Mailbox chat submission fingerprint changed");
		}
		const proposalFingerprint = await computeMailboxScopedFingerprint({
			inventory: value.inventory,
			metadata,
			actions: proposal.actions,
			targets: proposal.targets,
		});
		return validateMailboxPlanRevision({
			...proposal,
			inventoryFingerprint: proposalFingerprint,
		});
	};

	let marker: MailboxChatMarker | undefined;
	let emit: ((payload: unknown) => Promise<void>) | undefined;
	const chatReceiver: MailboxRuntimeChatReceiver = Object.freeze({
		open(nextMarker, nextEmit) {
			marker = nextMarker;
			emit = nextEmit;
		},
		async submit(message: MailboxChatSubmitMessage) {
			if (
				marker === undefined ||
				emit === undefined ||
				message.planAlias !== marker.planAlias ||
				message.requestAlias !== marker.requestAlias ||
				message.nonce !== marker.nonce
			) {
				throw new Error("Mailbox chat is unavailable");
			}
			await emit({
				schemaVersion: 1,
				type: "mailbox_chat_ack",
				planAlias: marker.planAlias,
				requestAlias: marker.requestAlias,
				nonce: marker.nonce,
			});
			let result: MailboxChatSubmitResult;
			try {
				result =
					(await options.authorChat?.(message)) ??
					Object.freeze({
						status: "error" as const,
						code: "provider_refused" as const,
					});
			} catch {
				result = Object.freeze({
					status: "error",
					code: "provider_timeout",
				});
			}
			await emit({
				schemaVersion: 1,
				type:
					result.status === "proposal"
						? "mailbox_chat_proposal"
						: result.status === "canceled"
							? "mailbox_chat_canceled"
							: "mailbox_chat_error",
				planAlias: marker.planAlias,
				requestAlias: marker.requestAlias,
				nonce: marker.nonce,
				...(result.status === "proposal"
					? { proposal: result.proposal }
					: result.status === "error"
						? { code: result.code }
						: {}),
			});
			return result;
		},
		reconnect() {},
		async cancel(nextMarker) {
			await options.cancelChat?.();
			if (emit !== undefined) {
				await emit({
					schemaVersion: 1,
					type: "mailbox_chat_canceled",
					planAlias: nextMarker.planAlias,
					requestAlias: nextMarker.requestAlias,
					nonce: nextMarker.nonce,
				});
			}
		},
		close() {
			marker = undefined;
			emit = undefined;
			void Promise.resolve(options.closeChat?.()).catch(() => undefined);
		},
	});

	return Object.freeze({
		launch,
		openRevision,
		preflightRevision,
		restartCapture,
		computeFingerprint,
		refingerprintProposal,
		chatReceiver,
	});
}
