import type {
	MailboxInventory,
	MailboxPlanRevision,
	MailboxReasonCode,
} from "@dg/common";

export const MAILBOX_CHAT_MESSAGE_TYPES = Object.freeze({
	submit: "mailbox_chat_submit",
	ack: "mailbox_chat_ack",
	proposal: "mailbox_chat_proposal",
	canceled: "mailbox_chat_canceled",
	error: "mailbox_chat_error",
} as const);

export type MailboxChatMarker = Readonly<{
	schemaVersion: 1;
	planAlias: string;
	requestAlias: string;
	nonce: string;
}>;

export type MailboxChatSubmission = Readonly<{
	inventory: MailboxInventory;
	revision: MailboxPlanRevision;
}>;

export type MailboxChatSubmitMessage = MailboxChatMarker &
	Readonly<{
		type: typeof MAILBOX_CHAT_MESSAGE_TYPES.submit;
		inventory: MailboxInventory;
		revision: MailboxPlanRevision;
	}>;

export type MailboxChatOutboundMessage = MailboxChatSubmitMessage;

export type MailboxChatSubmitResult =
	| Readonly<{
			status: "proposal";
			proposal: MailboxPlanRevision;
	  }>
	| Readonly<{ status: "canceled" }>
	| Readonly<{ status: "error"; code: MailboxReasonCode }>;

export type MailboxChatTransport = Readonly<{
	open(marker: MailboxChatMarker): Promise<void>;
	send(message: MailboxChatOutboundMessage): Promise<void>;
	subscribe(listener: (message: unknown) => void): () => void;
	reconnect(marker: MailboxChatMarker): Promise<void>;
	cancel(marker: MailboxChatMarker): Promise<void>;
	close(): Promise<void> | void;
}>;

export type MailboxChatBridgeDeps = Readonly<{
	transport: MailboxChatTransport;
	randomBytes: () => Uint8Array;
	now: () => number;
	setTimeout: (callback: () => void, milliseconds: number) => unknown;
	clearTimeout: (timer: unknown) => void;
	timeoutMs?: number;
}>;

export type MailboxChatBridge = Readonly<{
	open(planAlias: string): Promise<MailboxChatMarker>;
	submit(value: MailboxChatSubmission): Promise<MailboxChatSubmitResult>;
	cancel(): Promise<void>;
	reconnect(): Promise<void>;
	isOpen(): boolean;
	dispose(): void;
}>;
