import {
	MAILBOX_REASON_CODES,
	preflightMailboxValue,
	validateMailboxInventory,
	validateMailboxPlanRevision,
	type MailboxPlanRevision,
} from "@dg/common";
import { MAILBOX_CAPTURE_LIMITS } from "../coordinator";
import { deriveMailboxCohorts } from "../planning";
import type {
	MailboxChatMarker,
	MailboxChatOutboundMessage,
	MailboxChatTransport,
} from "./contracts";

const RUNTIME_MESSAGE_TYPES = Object.freeze({
	open: "dg-mailbox-cleanup:chat-open",
	submit: "dg-mailbox-cleanup:chat-submit",
	reconnect: "dg-mailbox-cleanup:chat-reconnect",
	cancel: "dg-mailbox-cleanup:chat-cancel",
	close: "dg-mailbox-cleanup:chat-close",
	inbound: "dg-mailbox-cleanup:chat-inbound",
} as const);

type RuntimeListener = (value: unknown) => unknown;

export type MailboxChatRuntimeSeam = Readonly<{
	sendMessage(value: unknown): Promise<unknown>;
	onMessage: Readonly<{
		addListener(listener: RuntimeListener): void;
		removeListener(listener: RuntimeListener): void;
	}>;
}>;

export type MailboxRuntimeChatReceiver = Readonly<{
	open(
		marker: MailboxChatMarker,
		emitInbound: (payload: unknown) => Promise<void>,
	): Promise<void> | void;
	submit(message: MailboxChatOutboundMessage): Promise<unknown> | unknown;
	reconnect(marker: MailboxChatMarker): Promise<void> | void;
	cancel(marker: MailboxChatMarker): Promise<void> | void;
	close(): Promise<void> | void;
}>;

export type MailboxRuntimeChatRegistration = Readonly<{
	dispose(): void;
}>;

export type MailboxRuntimeProposalFingerprintInput = Readonly<{
	inventory: MailboxChatOutboundMessage["inventory"];
	submittedRevision: MailboxChatOutboundMessage["revision"];
	proposal: MailboxPlanRevision;
}>;

function invalid(): never {
	throw new Error("Invalid mailbox chat runtime envelope");
}

function exact(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	try {
		preflightMailboxValue(value, {
			maxNodes: 100_000,
			maxKeys: 100_000,
			maxArrayLength: MAILBOX_CAPTURE_LIMITS.messages,
			maxTotalStringLength: MAILBOX_CAPTURE_LIMITS.chatPayloadCharacters,
			maxTotalBytes: MAILBOX_CAPTURE_LIMITS.chatPayloadCharacters * 2,
		});
	} catch {
		invalid();
	}
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		invalid();
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(input, key)) ||
		Object.keys(input).some((key) => !keys.includes(key))
	) {
		invalid();
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

function marker(value: unknown): MailboxChatMarker {
	const input = exact(value, [
		"schemaVersion",
		"planAlias",
		"requestAlias",
		"nonce",
	]);
	if (
		input.schemaVersion !== 1 ||
		typeof input.planAlias !== "string" ||
		typeof input.requestAlias !== "string" ||
		typeof input.nonce !== "string" ||
		!/^plan_[a-f0-9]{32}$/.test(input.planAlias) ||
		!/^act_[a-f0-9]{32}$/.test(input.requestAlias) ||
		!/^[a-f0-9]{32}$/.test(input.nonce)
	) {
		invalid();
	}
	return Object.freeze({
		schemaVersion: 1,
		planAlias: input.planAlias,
		requestAlias: input.requestAlias,
		nonce: input.nonce,
	});
}

function outbound(value: unknown): MailboxChatOutboundMessage {
	const input = exact(value, [
		"schemaVersion",
		"type",
		"planAlias",
		"requestAlias",
		"nonce",
		"inventory",
		"revision",
	]);
	if (
		input.type !== "mailbox_chat_submit" ||
		input.schemaVersion !== 1
	) {
		invalid();
	}
	const safeMarker = marker({
		schemaVersion: input.schemaVersion,
		planAlias: input.planAlias,
		requestAlias: input.requestAlias,
		nonce: input.nonce,
	});
	let inventory;
	let revision;
	try {
		inventory = deepFreeze(
			validateMailboxInventory(structuredClone(input.inventory)),
		);
		revision = deepFreeze(
			validateMailboxPlanRevision(structuredClone(input.revision)),
		);
	} catch {
		invalid();
	}
	if (
		inventory.partial ||
		revision.state !== "draft" ||
		revision.planAlias !== safeMarker.planAlias
	) {
		invalid();
	}
	const message = Object.freeze({
		...safeMarker,
		type: "mailbox_chat_submit",
		inventory,
		revision,
	});
	validateRevisionScope(revision, message);
	return message;
}

function sameMarker(
	left: MailboxChatMarker,
	right: MailboxChatMarker,
): boolean {
	return (
		left.planAlias === right.planAlias &&
		left.requestAlias === right.requestAlias &&
		left.nonce === right.nonce
	);
}

function validateRevisionScope(
	revision: MailboxPlanRevision,
	message: MailboxChatOutboundMessage,
): void {
	const messages = new Set(
		message.inventory.messages.map((item) => item.alias),
	);
	const folders = new Set(
		message.inventory.folders.map((item) => item.alias),
	);
	const filters = new Set(
		message.inventory.filters.map((item) => item.alias),
	);
	const allowedLabels = new Set(
		message.revision.targets.labelAliases,
	);
	const allowedFolders = new Set(
		message.revision.targets.folderAliases,
	);
	const allowedFilters = new Set(
		message.revision.targets.filterAliases,
	);
	if (
		JSON.stringify(revision.cohorts) !==
			JSON.stringify(deriveMailboxCohorts(message.inventory)) ||
		revision.targets.folderAliases.some(
			(alias) => !folders.has(alias) || !allowedFolders.has(alias),
		) ||
		revision.targets.labelAliases.some(
			(alias) => !allowedLabels.has(alias),
		) ||
		revision.targets.filterAliases.some(
			(alias) => !filters.has(alias) || !allowedFilters.has(alias),
		) ||
		revision.actions.some((action) => {
			if ("messageAlias" in action && !messages.has(action.messageAlias)) {
				return true;
			}
			if (action.type === "move_to_folder") {
				return !revision.targets.folderAliases.includes(
					action.folderAlias,
				);
			}
			if (action.type === "apply_label" || action.type === "remove_label") {
				return !revision.targets.labelAliases.includes(action.labelAlias);
			}
			if (action.type === "deactivate_filter") {
				return !revision.targets.filterAliases.includes(
					action.filterAlias,
				);
			}
			return false;
		})
	) {
		invalid();
	}
}

async function inbound(
	value: unknown,
	activeMarker: MailboxChatMarker | undefined,
	submission: MailboxChatOutboundMessage | undefined,
	verifyProposalFingerprint:
		| ((
				input: MailboxRuntimeProposalFingerprintInput,
		  ) => Promise<boolean>)
		| undefined,
): Promise<unknown> {
	if (activeMarker === undefined) invalid();
	const type =
		value !== null && typeof value === "object"
			? (value as { type?: unknown }).type
			: undefined;
	const baseKeys = [
		"schemaVersion",
		"type",
		"planAlias",
		"requestAlias",
		"nonce",
	];
	const input = exact(
		value,
		type === "mailbox_chat_proposal"
			? [...baseKeys, "proposal"]
			: type === "mailbox_chat_error"
				? [...baseKeys, "code"]
				: baseKeys,
	);
	const scopedMarker = marker({
		schemaVersion: input.schemaVersion,
		planAlias: input.planAlias,
		requestAlias: input.requestAlias,
		nonce: input.nonce,
	});
	if (!sameMarker(activeMarker, scopedMarker)) invalid();
	if (submission === undefined) invalid();
	if (
		type === "mailbox_chat_ack" ||
		type === "mailbox_chat_canceled"
	) {
		return Object.freeze({ ...input });
	}
	if (type === "mailbox_chat_error") {
		if (
			typeof input.code !== "string" ||
			!MAILBOX_REASON_CODES.includes(
				input.code as (typeof MAILBOX_REASON_CODES)[number],
			)
		) {
			invalid();
		}
		return Object.freeze({ ...input });
	}
	if (
		type !== "mailbox_chat_proposal" ||
		verifyProposalFingerprint === undefined
	) {
		invalid();
	}
	let proposal;
	try {
		proposal = deepFreeze(
			validateMailboxPlanRevision(structuredClone(input.proposal)),
		);
	} catch {
		invalid();
	}
	if (
		proposal.state !== "draft" ||
		proposal.planAlias !== activeMarker.planAlias
	) {
		invalid();
	}
	validateRevisionScope(proposal, submission);
	let fingerprintMatches = false;
	try {
		fingerprintMatches = await verifyProposalFingerprint({
			inventory: submission.inventory,
			submittedRevision: submission.revision,
			proposal,
		});
	} catch {
		invalid();
	}
	if (!fingerprintMatches) invalid();
	return Object.freeze({ ...input, proposal });
}

export function createMailboxRuntimeChatTransport(deps: {
	runtime: MailboxChatRuntimeSeam;
}): MailboxChatTransport {
	return Object.freeze({
		async open(value) {
			await deps.runtime.sendMessage({
				type: RUNTIME_MESSAGE_TYPES.open,
				marker: value,
			});
		},
		async send(message) {
			await deps.runtime.sendMessage({
				type: RUNTIME_MESSAGE_TYPES.submit,
				message,
			});
		},
		subscribe(listener) {
			const onMessage: RuntimeListener = (value) => {
				let envelope: Record<string, unknown>;
				try {
					envelope = exact(value, ["type", "payload"]);
				} catch {
					return;
				}
				if (envelope.type === RUNTIME_MESSAGE_TYPES.inbound) {
					listener(envelope.payload);
				}
			};
			deps.runtime.onMessage.addListener(onMessage);
			return () => deps.runtime.onMessage.removeListener(onMessage);
		},
		async reconnect(value) {
			await deps.runtime.sendMessage({
				type: RUNTIME_MESSAGE_TYPES.reconnect,
				marker: value,
			});
		},
		async cancel(value) {
			await deps.runtime.sendMessage({
				type: RUNTIME_MESSAGE_TYPES.cancel,
				marker: value,
			});
		},
		async close() {
			await deps.runtime.sendMessage({
				type: RUNTIME_MESSAGE_TYPES.close,
			});
		},
	});
}

export function registerMailboxRuntimeChatHandoff(deps: {
	runtime: MailboxChatRuntimeSeam;
	receiver: MailboxRuntimeChatReceiver;
	verifyProposalFingerprint?(
		input: MailboxRuntimeProposalFingerprintInput,
	): Promise<boolean>;
}): MailboxRuntimeChatRegistration {
	let activeMarker: MailboxChatMarker | undefined;
	let opening:
		| Readonly<{
				marker: MailboxChatMarker;
				result: Promise<void>;
		  }>
		| undefined;
	let closed = false;
	let listenerRemoved = false;
	const submissions = new Map<
		string,
		Readonly<{
			canonical: string;
			message: MailboxChatOutboundMessage;
			result: Promise<unknown>;
		}>
	>();
	const emitInbound = async (payload: unknown): Promise<void> => {
		if (closed) return;
		const current =
			activeMarker === undefined
				? undefined
				: submissions.get(
						`${activeMarker.requestAlias}:${activeMarker.nonce}`,
					)?.message;
		const safe = await inbound(
			payload,
			activeMarker,
			current,
			deps.verifyProposalFingerprint,
		);
		await deps.runtime.sendMessage({
			type: RUNTIME_MESSAGE_TYPES.inbound,
			payload: safe,
		});
	};
	const listener: RuntimeListener = async (value) => {
		if (closed) invalid();
		const envelope = exact(
			value,
			(value as { type?: unknown })?.type === RUNTIME_MESSAGE_TYPES.close
				? ["type"]
				: (value as { type?: unknown })?.type ===
						RUNTIME_MESSAGE_TYPES.submit
					? ["type", "message"]
					: ["type", "marker"],
		);
		switch (envelope.type) {
			case RUNTIME_MESSAGE_TYPES.open: {
				const nextMarker = marker(envelope.marker);
				if (
					activeMarker !== undefined &&
					!sameMarker(activeMarker, nextMarker)
				) {
					invalid();
				}
				if (activeMarker !== undefined) return;
				if (opening !== undefined) {
					if (!sameMarker(opening.marker, nextMarker)) invalid();
					await opening.result;
					return;
				}
				const result = Promise.resolve().then(() =>
					deps.receiver.open(nextMarker, emitInbound),
				);
				opening = Object.freeze({ marker: nextMarker, result });
				try {
					await result;
					activeMarker = nextMarker;
				} finally {
					opening = undefined;
				}
				return;
			}
			case RUNTIME_MESSAGE_TYPES.submit: {
				const message = outbound(envelope.message);
				if (
					activeMarker === undefined ||
					!sameMarker(activeMarker, message)
				) {
					invalid();
				}
				const key = `${message.requestAlias}:${message.nonce}`;
				const canonical = JSON.stringify(message);
				const existing = submissions.get(key);
				if (existing !== undefined) {
					if (existing.canonical !== canonical) invalid();
					return existing.result;
				}
				const result = Promise.resolve().then(() =>
					deps.receiver.submit(message),
				);
				submissions.set(key, { canonical, message, result });
				try {
					return await result;
				} catch (error) {
					submissions.delete(key);
					throw error;
				}
			}
			case RUNTIME_MESSAGE_TYPES.reconnect: {
				const nextMarker = marker(envelope.marker);
				if (
					activeMarker === undefined ||
					!sameMarker(activeMarker, nextMarker)
				) {
					invalid();
				}
				await deps.receiver.reconnect(nextMarker);
				return;
			}
			case RUNTIME_MESSAGE_TYPES.cancel: {
				const nextMarker = marker(envelope.marker);
				if (
					activeMarker === undefined ||
					!sameMarker(activeMarker, nextMarker)
				) {
					invalid();
				}
				await deps.receiver.cancel(nextMarker);
				return;
			}
			case RUNTIME_MESSAGE_TYPES.close:
				closed = true;
				deps.runtime.onMessage.removeListener(listener);
				listenerRemoved = true;
				await deps.receiver.close();
				return;
			default:
				invalid();
		}
	};
	deps.runtime.onMessage.addListener(listener);
	return Object.freeze({
		dispose() {
			if (listenerRemoved) return;
			closed = true;
			deps.runtime.onMessage.removeListener(listener);
			listenerRemoved = true;
			void Promise.resolve(deps.receiver.close()).catch(() => undefined);
		},
	});
}
