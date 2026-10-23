export type MailAttachment = {
	id: string;
	name: string;
	contentType: string;
	size: number;
	isInline: boolean;
};

/** Shared by list and search; `since` is always a normalized ISO string by the time a client sees it. */
export type MailQuery = {
	folderId?: string;
	unread?: boolean;
	since?: string;
	from?: string;
	subject?: string;
	text?: string;
	limit: number;
	page: number;
};

/** List results carry a preview in `text`; `getMessage`/`getDraft` carry the full body there instead. */
export type MailMessage = {
	id: string;
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	receivedAt: string;
	folderId: string;
	isRead: boolean;
	hasAttachments: boolean;
	text: string;
	html?: string;
	uniqueText?: string;
	attachments: MailAttachment[];
};

export type MailPage = {
	messages: MailMessage[];
	hasMore: boolean;
};

export type MailDraftInput = {
	to: string[];
	cc: string[];
	subject: string;
	text: string;
};

/** `replyAll` picks the provider's native reply-all behavior; `cc` adds to it rather than replacing it. */
export type MailReplyDraftInput = {
	messageId: string;
	replyAll: boolean;
	cc: string[];
	text: string;
};

/** One mail account's read, draft, and send surface; every verb runs against this regardless of provider. */
export interface MailAccessClient {
	listMessages(query: MailQuery): Promise<MailPage>;
	searchMessages(query: MailQuery): Promise<MailPage>;
	getMessage(id: string): Promise<MailMessage>;
	listAttachments(id: string): Promise<MailAttachment[]>;
	createDraft(input: MailDraftInput): Promise<MailMessage>;
	createReplyDraft(input: MailReplyDraftInput): Promise<MailMessage>;
	getDraft(id: string): Promise<MailMessage>;
	sendDraft(id: string): Promise<void>;
	close?(): Promise<void>;
}
