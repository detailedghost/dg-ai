export const SMS_PROVIDERS = ["google", "signal"] as const;

export type SmsProviderId = (typeof SMS_PROVIDERS)[number];

export const SMS_CAPABILITIES = [
	"link",
	"status",
	"listConversations",
	"readRecent",
	"receive",
	"archive",
	"blockAndReportSpam",
	"draftReply",
	"sendDraft",
	"reactions",
	"attachments",
	"quotes",
] as const;

export type SmsCapability = (typeof SMS_CAPABILITIES)[number];

export type CapabilityMap = Readonly<Record<SmsCapability, boolean>>;

export type LinkState = "paired" | "signed-out" | "phone-unreachable" | "unknown";

export interface LinkInput {
	deviceName?: string;
	onUri?: (uri: string) => void | Promise<void>;
}

export interface LinkResult {
	linked: boolean;
	accountId: string;
	state: LinkState | "linked";
	reason: string;
	deviceName?: string;
	uri?: string;
}

export interface StatusResult {
	linked: boolean;
	accountIds: string[];
	state: LinkState | "linked";
	reason: string;
}

export interface Conversation {
	id: string;
	title: string;
	preview: string;
	pinned: boolean;
	savedContact: boolean;
	ageDays: number;
	kind: "dm" | "group";
}

export interface SmsAttachment {
	id: string;
	contentType: string;
	byteLength: number;
	path?: string;
}

export interface SmsQuote {
	authorId: string;
	timestamp: number;
	text?: string;
}

export interface SmsReaction {
	emoji: string;
	targetTimestamp: number;
	targetAuthorId: string;
	remove: boolean;
}

export interface SmsMessage {
	id: string;
	conversationId: string;
	timestamp: number;
	direction: "in" | "out";
	senderId: string;
	text?: string;
	reaction?: SmsReaction;
	attachments: SmsAttachment[];
	quote?: SmsQuote;
}

export interface DraftAttachment {
	path: string;
	contentType: string;
	sha256?: string;
}

export interface DraftRecord {
	id: string;
	provider: SmsProviderId;
	conversationId: string;
	text?: string;
	emoji?: string;
	remove?: boolean;
	targetTimestamp?: number;
	targetAuthorId?: string;
	attachments: DraftAttachment[];
	quote?: SmsQuote;
	approvalTokenHash?: string;
	createdAt: string;
	status: "pending" | "sending" | "sent" | "uncertain";
}

export interface DraftReplyInput {
	conversationId: string;
	text?: string;
	emoji?: string;
	remove?: boolean;
	targetTimestamp?: number;
	targetAuthorId?: string;
	attachments?: DraftAttachment[];
	quote?: SmsQuote;
}

export interface SendDraftInput {
	draftId: string;
	confirmed: boolean;
	hook: boolean;
}

export interface SendResult {
	draftId: string;
	reason: "sent";
}

export interface MutationInput {
	conversationId: string;
}

export interface MutationResult {
	conversationId: string;
	reason: string;
}

export interface ReceiveInput {
	limit: number;
	timeoutMs: number;
	conversationId?: string;
}

export interface SmsProvider {
	readonly id: SmsProviderId;
	readonly capabilities: CapabilityMap;
	link(input: LinkInput): Promise<LinkResult>;
	status(): Promise<StatusResult>;
	listConversations(): Promise<Conversation[]>;
	readRecent(conversationId: string, limit: number): Promise<SmsMessage[]>;
	receive(input: ReceiveInput): Promise<SmsMessage[]>;
	archive(input: MutationInput): Promise<MutationResult>;
	blockAndReportSpam(input: MutationInput): Promise<MutationResult>;
	draftReply(input: DraftReplyInput): Promise<DraftRecord>;
	sendDraft(input: SendDraftInput): Promise<SendResult>;
}
