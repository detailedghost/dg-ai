import {
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
import type {
	MailboxProvider,
	MailboxProviderCaptureRequest,
} from "../features/mailbox-cleanup/providers";
import {
	type RawBindingScope,
	type RawBindingStore,
	type SessionStorageSeam,
} from "../features/mailbox-cleanup/storage";
import {
	writeAndOpenMailboxPlan,
	type MailboxPlanWorkspaceInput,
} from "../features/mailbox-cleanup/plan-page";

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

function capturedBindingsOnly(
	capture: SuccessfulCapture,
	bindings: Readonly<Record<string, string>>,
): SuccessfulCapture {
	const retained = <Item extends Readonly<{ alias: string }>>(
		items: readonly Item[],
	): readonly Item[] =>
		Object.freeze(
			items.filter((item) => Object.hasOwn(bindings, item.alias)),
		);
	return Object.freeze({
		...capture,
		inventory: Object.freeze({
			...capture.inventory,
			messages: retained(capture.inventory.messages),
			folders: retained(capture.inventory.folders),
			labels: retained(capture.inventory.labels),
			filters: retained(capture.inventory.filters),
		}),
		metadata: Object.freeze({
			tags: retained(capture.metadata.tags),
			categories: retained(capture.metadata.categories),
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
		const scope = value.scope as MailboxProviderCaptureRequest;
		const bindings = value.bindings as Readonly<Record<string, string>>;
		const { provider } = selectedProvider(options.providers, scope);
		const capture = capturedBindingsOnly(
			await coordinatorCapture(provider, scope, options.now),
			bindings,
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
		computeFingerprint,
		refingerprintProposal,
		chatReceiver,
	});
}
