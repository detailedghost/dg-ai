import type {
	MailboxAction,
	MailboxPlanRevision,
	MailboxRevisionTargets,
} from "@dg/common";
import type { MailboxScopedFingerprintInput } from "../lib/features/mailbox-cleanup/planning";
import {
	createMailboxPlanWorkspace,
	type SuccessfulMailboxCapture,
	type MailboxPlanWorkspace,
} from "../lib/features/mailbox-cleanup/plan-page";
import {
	bindingScope,
	captureResult,
	fingerprint,
	localHints,
	NEXT_REVISION_ALIAS,
	NOW_MS,
	revision,
} from "./mailbox-plan-page-fixtures";

export type SnapshotView = Readonly<{
	selectedChoiceId: "conservative" | "balanced" | "inbox_zero";
	actions: readonly MailboxAction[];
	targets: MailboxRevisionTargets;
	reviewMessageAliases: readonly string[];
	excludedMessageAliases: readonly string[];
	revision: MailboxPlanRevision;
	restartRequired: boolean;
	bindingAvailable: boolean;
	transitionPending: boolean;
	chatAvailable: boolean;
	planExpired: boolean;
	dirty: boolean;
	bindingExpiresAt: number;
	operationStatus: string;
	chatStatus: string;
	chatMessage: string;
	canReconnect: boolean;
}>;

export type WorkspaceHarnessOptions = Readonly<{
	count?: number;
	partial?: boolean;
	bindingAvailable?: boolean;
	restartRequired?: boolean;
	localHintsEnabled?: boolean;
	planExpiresAt?: number;
	bindingExpiresAt?: number;
	transitionGate?: Promise<void>;
	fingerprintGate?: Promise<void>;
	touchGate?: Promise<void>;
	rebindGate?: Promise<void>;
	baseRevision?: MailboxPlanRevision;
	capture?: SuccessfulMailboxCapture;
	bridgeResults?: readonly unknown[];
	renewedBindingExpiresAt?: number;
	transitionInvalidatesBinding?: boolean;
	bridgeInitiallyOpen?: boolean;
	bridgeHasIsOpen?: boolean;
	statusGate?: Promise<void>;
	createActionAlias?: () => string;
}>;

export function workspaceHarness(options: WorkspaceHarnessOptions = {}) {
	let bindingAvailable = options.bindingAvailable ?? true;
	let nowMs = NOW_MS;
	let currentBindingExpiresAt =
		options.bindingExpiresAt ?? NOW_MS + 60 * 60 * 1_000;
	const touches: string[] = [];
	const lifecycleCalls: Array<readonly unknown[]> = [];
	const bridgeSubmissions: unknown[] = [];
	const bridgeReconnects: number[] = [];
	const bindingGetCalls: unknown[] = [];
	const bindingPuts: Array<readonly unknown[]> = [];
	const bindingStatusCalls: unknown[] = [];
	const fingerprintInputs: MailboxScopedFingerprintInput[] = [];
	const executionStarts: unknown[] = [];
	let lifecycleEditError: Error | undefined;
	let rawBindingGetError: Error | undefined;
	let bindingStatusError:
		| Readonly<{ call: number; error: Error }>
		| undefined;
	let bridgeOpen = options.bridgeInitiallyOpen ?? true;
	const capture =
		options.capture ??
		captureResult({
			count: options.count,
			partial: options.partial,
		});
	const baseRevision =
		options.baseRevision ??
		revision({
			restartRequired: options.restartRequired ?? false,
		});
	let bridgeResultIndex = 0;
	let actionAliasSeed = 0;
	const lifecycle = {
		async create(value: MailboxPlanRevision) {
			lifecycleCalls.push(["create", value]);
			return value;
		},
		async edit(
			planAlias: string,
			basedOnRevisionAlias: string,
			value: MailboxPlanRevision,
		) {
			lifecycleCalls.push(["edit", planAlias, basedOnRevisionAlias, value]);
			if (lifecycleEditError !== undefined) throw lifecycleEditError;
			return value;
		},
		async transition(
			change: Readonly<{
				nextState: MailboxPlanRevision["state"];
			}>,
		) {
			lifecycleCalls.push(["transition", change]);
			await options.transitionGate;
			if (options.transitionInvalidatesBinding) bindingAvailable = false;
			return { ...baseRevision, state: change.nextState };
		},
	};
	const rawBindings = {
		async get(scope: unknown) {
			bindingGetCalls.push(scope);
			await options.rebindGate;
			if (rawBindingGetError !== undefined) throw rawBindingGetError;
			return bindingAvailable
				? { [baseRevision.cohorts[0]!.messageAliases[0]!]: "raw-1" }
				: undefined;
		},
		async touch(_scope: unknown, event: string) {
			touches.push(event);
			await options.touchGate;
			if (bindingAvailable && options.renewedBindingExpiresAt !== undefined) {
				currentBindingExpiresAt = options.renewedBindingExpiresAt;
			}
			return bindingAvailable;
		},
		async status(scope: unknown) {
			bindingStatusCalls.push(scope);
			await options.statusGate;
			if (bindingStatusError?.call === bindingStatusCalls.length) {
				throw bindingStatusError.error;
			}
			return bindingAvailable
				? { available: true as const, expiresAt: currentBindingExpiresAt }
				: { available: false as const, reason: "expired" as const };
		},
		async put(scope: unknown, value: unknown) {
			bindingPuts.push([scope, value]);
		},
	};
	const bridgeBase = {
		async submit(value: unknown) {
			bridgeSubmissions.push(value);
			return (
				options.bridgeResults?.[bridgeResultIndex++] ?? {
					status: "submitted",
					requestAlias: "act_00112233445566778899aabbccddeeff",
				}
			);
		},
		async reconnect() {
			bridgeReconnects.push(bridgeReconnects.length + 1);
			bridgeOpen = true;
		},
	};
	const bridge =
		options.bridgeHasIsOpen === false
			? bridgeBase
			: {
					...bridgeBase,
					isOpen() {
						return bridgeOpen;
					},
				};
	const workspace = createMailboxPlanWorkspace(
		{
			capture,
			baseRevision,
			bindingScope: bindingScope(),
			bindingExpiresAt: currentBindingExpiresAt,
			planExpiresAt:
				options.planExpiresAt ?? NOW_MS + 30 * 24 * 60 * 60 * 1_000,
			...(options.localHintsEnabled ? { localHints: localHints() } : {}),
		},
		{
			lifecycle,
			rawBindings,
			computeFingerprint: async (value: MailboxScopedFingerprintInput) => {
				fingerprintInputs.push(structuredClone(value));
				await options.fingerprintGate;
				return fingerprint("b");
			},
			createRevisionAlias: () => NEXT_REVISION_ALIAS,
			createActionAlias:
				options.createActionAlias ??
				(() => {
					actionAliasSeed += 1;
					return `act_89abcdef0123456789abcdef${actionAliasSeed
						.toString(16)
						.padStart(8, "0")}`;
				}),
			now: () => nowMs,
			bridge,
			async startExecution(command: Readonly<{
				planAlias: string;
				revisionAlias: string;
			}>) {
				executionStarts.push(structuredClone(command));
			},
		} as never,
	);
	return {
		baseRevision,
		bindingGetCalls,
		bindingPuts,
		bindingStatusCalls,
		bridgeSubmissions,
		bridgeReconnects,
		fingerprintInputs,
		executionStarts,
		lifecycleCalls,
		setBindingAvailable(value: boolean) {
			bindingAvailable = value;
		},
		setLifecycleEditError(value: Error | undefined) {
			lifecycleEditError = value;
		},
		setRawBindingGetError(value: Error | undefined) {
			rawBindingGetError = value;
		},
		setBindingStatusErrorAtCall(call: number, error: Error | undefined) {
			bindingStatusError =
				error === undefined ? undefined : { call, error };
		},
		setNow(value: number) {
			nowMs = value;
		},
		touches,
		workspace,
	};
}

export function view(workspace: MailboxPlanWorkspace): SnapshotView {
	return workspace.getSnapshot() as SnapshotView;
}
