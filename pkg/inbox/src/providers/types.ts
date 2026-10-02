export type MailProvider = "protonmail" | "outlook" | "gmail";

export type MailFolder = {
	id: string;
	name: string;
	type: "folder" | "label" | "system";
	path?: string;
	parentId?: string;
	total?: number;
	unread?: number;
	aliases?: string[];
};

export type MailRule = {
	id: string;
	name: string;
	enabled: boolean;
	conditions: string[];
	actions: string[];
	sequence?: number;
};

export type MailLabel = {
	id: string;
	name: string;
	color?: string;
	type?: "category" | "label";
};

export type MailMessageSummary = {
	id: string;
	from: string;
	fromDomain?: string;
	senderName?: string;
	subject: string;
	snippet: string;
	folderId: string;
	folderName?: string;
	read?: boolean;
	isRead?: boolean;
	receivedAt?: string;
	categories?: string[];
	labels?: string[];
	threadId?: string;
};

export type MailDataset = {
	folders: MailFolder[];
	filters: MailRule[];
	messages: MailMessageSummary[];
};

export type ListMessagesInput = {
	folderId?: string;
	folderName?: string;
	limit: number;
};

export type CreateMailFolderInput = {
	name: string;
	type?: "folder" | "label";
};

export type CreateMailFilterInput = {
	name: string;
	sieve?: string;
	criteria?: Record<string, unknown>;
	action?: Record<string, unknown>;
	enabled?: boolean;
};

export type UpdateMailFilterInput = CreateMailFilterInput & {
	id: string;
};

export interface MailProviderClient {
	provider: MailProvider;
	listFolders(): Promise<MailFolder[]>;
	listLabels?(): Promise<MailLabel[]>;
	createFolder?(input: CreateMailFolderInput): Promise<MailFolder>;
	renameFolder?(input: {
		id: string;
		displayName: string;
	}): Promise<MailFolder>;
	moveFolder?(input: {
		id: string;
		destinationId: string;
	}): Promise<MailFolder>;
	listFilters(): Promise<MailRule[]>;
	createFilter?(input: CreateMailFilterInput): Promise<MailRule>;
	updateFilter?(input: UpdateMailFilterInput): Promise<MailRule>;
	deleteFilter?(input: { id: string }): Promise<void>;
	listMessages(input: ListMessagesInput): Promise<MailMessageSummary[]>;
	/**
	 * Optional streaming variant that yields one provider page at a time, letting
	 * `batch` overlap network pagination with redaction/disk writes instead of
	 * buffering the whole mailbox first. Providers without it fall back to
	 * `listMessages` as a single page.
	 */
	listMessagesStream?(
		input: ListMessagesInput,
	): AsyncIterable<MailMessageSummary[]>;
	moveMessages(input: {
		messageIds: string[];
		targetFolderId: string;
	}): Promise<void>;
	unlabelMessages?(input: {
		messageIds: string[];
		labelId: string;
	}): Promise<void>;
	markMessagesRead(input: { messageIds: string[] }): Promise<void>;
	close?(): Promise<void>;
}
