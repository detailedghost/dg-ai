import {
	registerMailboxRuntimeChatHandoff,
	type MailboxChatRuntimeSeam,
	type MailboxRuntimeProposalFingerprintInput,
	type MailboxRuntimeChatReceiver,
} from "../features/mailbox-cleanup/bridge";
import type { MailboxPlanRevision } from "@dg/common";
import type {
	MailboxExecutionCommand,
	MailboxExecutionCoordinator,
} from "../features/mailbox-cleanup/execution";
import {
	MAILBOX_CLI_APPROVAL_DECISION_TYPE,
	MAILBOX_CLI_APPROVAL_INSPECT_TYPE,
	type MailboxCliConnection,
	type MailboxCliRuntimeSender,
	validateMailboxCliApprovalEnvelope,
	validateMailboxCliConnectEnvelope,
} from "../features/mailbox-cleanup/cli-transport";

type RuntimeListener = (
	value: unknown,
	sender?: MailboxCliRuntimeSender,
) => unknown;

type MailboxCleanupRuntime = Readonly<{
	sendMessage(value: unknown): Promise<unknown>;
	onMessage: Readonly<{
		addListener(listener: RuntimeListener): void;
		removeListener(listener: RuntimeListener): void;
	}>;
}>;

export type MailboxCleanupBackgroundDeps = Readonly<{
	runtime: MailboxCleanupRuntime;
	chatReceiver: MailboxRuntimeChatReceiver;
	verifyProposalFingerprint?(
		input: MailboxRuntimeProposalFingerprintInput,
	): Promise<boolean | MailboxPlanRevision>;
	execution: Pick<
		MailboxExecutionCoordinator,
		"start" | "resume" | "cancel"
	> &
			Partial<Pick<MailboxExecutionCoordinator, "status">>;
	cli?: Readonly<{
		connect(
			value: MailboxCliConnection,
			sender: MailboxCliRuntimeSender,
		): Promise<void>;
		inspect(
			approvalAlias: string,
			sender: MailboxCliRuntimeSender,
		): Promise<unknown>;
		decide(
			approvalAlias: string,
			decision: "approve" | "deny",
			sender: MailboxCliRuntimeSender,
		): Promise<void>;
	}>;
}>;

export type MailboxCleanupBackgroundRegistration = Readonly<{
	dispose(): void;
}>;

type SharedRegistration = {
	references: number;
	dispose(): void;
};

const registrations = new WeakMap<object, SharedRegistration>();
const EXECUTION_TYPES = Object.freeze({
	"dg-mailbox-cleanup:execution-start": "start",
	"dg-mailbox-cleanup:execution-resume": "resume",
	"dg-mailbox-cleanup:execution-cancel": "cancel",
	"dg-mailbox-cleanup:execution-status": "status",
} as const);
const PLAN_ALIAS = /^plan_[a-f0-9]{32}$/;
const REVISION_ALIAS = /^rev_[a-f0-9]{32}$/;
const MAX_DELIVERIES = 256;

function exactCommand(value: unknown): MailboxExecutionCommand {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).length !== 2
	) {
		throw new Error("Invalid mailbox cleanup execution envelope");
	}
	const input = value as Record<string, unknown>;
	if (
		typeof input.planAlias !== "string" ||
		!PLAN_ALIAS.test(input.planAlias) ||
		typeof input.revisionAlias !== "string" ||
		!REVISION_ALIAS.test(input.revisionAlias)
	) {
		throw new Error("Invalid mailbox cleanup execution envelope");
	}
	return Object.freeze({
		planAlias: input.planAlias,
		revisionAlias: input.revisionAlias,
	});
}

function executionEnvelope(
	value: unknown,
):
	| Readonly<{
			type: keyof typeof EXECUTION_TYPES;
			command: MailboxExecutionCommand;
	  }>
	| undefined {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		return undefined;
	}
	const input = value as Record<string, unknown>;
	if (
		typeof input.type !== "string" ||
		!Object.hasOwn(EXECUTION_TYPES, input.type)
	) {
		return undefined;
	}
	if (
		Object.keys(input).length !== 2 ||
		!Object.hasOwn(input, "command")
	) {
		throw new Error("Invalid mailbox execution envelope");
	}
	return Object.freeze({
		type: input.type as keyof typeof EXECUTION_TYPES,
		command: exactCommand(input.command),
	});
}

export function registerMailboxCleanupBackground(
	deps: MailboxCleanupBackgroundDeps,
): MailboxCleanupBackgroundRegistration {
	const existing = registrations.get(deps.runtime);
	if (existing !== undefined) {
		existing.references += 1;
		let disposed = false;
		return Object.freeze({
			dispose() {
				if (disposed) return;
				disposed = true;
				existing.references -= 1;
				if (existing.references === 0) {
					registrations.delete(deps.runtime);
					existing.dispose();
				}
			},
		});
	}

	const chatListeners = new Set<RuntimeListener>();
	const chatRuntime: MailboxChatRuntimeSeam = {
		sendMessage: (value) => deps.runtime.sendMessage(value),
		onMessage: {
			addListener(listener) {
				chatListeners.add(listener);
			},
			removeListener(listener) {
				chatListeners.delete(listener);
			},
		},
	};
	const chat = registerMailboxRuntimeChatHandoff({
		runtime: chatRuntime,
		receiver: deps.chatReceiver,
		verifyProposalFingerprint: deps.verifyProposalFingerprint,
	});
	const deliveries = new Map<string, Promise<unknown>>();
	const listener: RuntimeListener = (value, sender = {}) => {
		const cli = validateMailboxCliConnectEnvelope(value);
		if (cli !== undefined) {
			if (deps.cli === undefined) {
				return Promise.reject(
					new Error("Mailbox CLI transport is unavailable"),
				);
			}
			return deps.cli.connect(cli.connection, sender);
		}
		const approval = validateMailboxCliApprovalEnvelope(value);
		if (approval !== undefined) {
			if (deps.cli === undefined) {
				return Promise.reject(
					new Error("Mailbox CLI approval is unavailable"),
				);
			}
			if (approval.type === MAILBOX_CLI_APPROVAL_INSPECT_TYPE) {
				return deps.cli.inspect(approval.approvalAlias, sender);
			}
			if (approval.type === MAILBOX_CLI_APPROVAL_DECISION_TYPE) {
				return deps.cli.decide(
					approval.approvalAlias,
					approval.decision,
					sender,
				);
			}
		}
		const execution = executionEnvelope(value);
		if (execution === undefined) {
			return Promise.all(
				[...chatListeners].map((chatListener) => chatListener(value)),
			);
		}
		const operation = EXECUTION_TYPES[execution.type];
		const key = `${operation}:${execution.command.planAlias}:${execution.command.revisionAlias}`;
			const current = deliveries.get(key);
			if (current !== undefined) return current;
			if (deliveries.size >= MAX_DELIVERIES) {
				return Promise.resolve({
					status: "paused",
					reasonCode: "worker_suspended",
					resumable: true,
				});
			}
			const handler = deps.execution[operation];
		if (typeof handler !== "function") {
			return Promise.resolve({
				status: "failed",
				reasonCode: "provider_refused",
				resumable: false,
			});
		}
			const result = Promise.resolve()
				.then(() => handler.call(deps.execution, execution.command))
				.finally(() => {
					if (deliveries.get(key) === result) deliveries.delete(key);
			});
			deliveries.set(key, result);
			return result;
	};
	deps.runtime.onMessage.addListener(listener);

	const shared: SharedRegistration = {
		references: 1,
		dispose() {
			deps.runtime.onMessage.removeListener(listener);
			chat.dispose();
			chatListeners.clear();
			deliveries.clear();
		},
	};
	registrations.set(deps.runtime, shared);

	let disposed = false;
	return Object.freeze({
		dispose() {
			if (disposed) return;
			disposed = true;
			shared.references -= 1;
			if (shared.references === 0) {
				registrations.delete(deps.runtime);
				shared.dispose();
			}
		},
	});
}
