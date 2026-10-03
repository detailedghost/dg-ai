/** Providers supported by the reusable inbox workflow. */
export type MailProvider = "protonmail" | "outlook" | "gmail";

/** Private folder selectors retain exact names and paths; redact a copy before public output. */
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

/** Normalized policy metadata for review; conditions/actions may contain private routing details. */
export type MailRule = {
	id: string;
	name: string;
	enabled: boolean;
	conditions: string[];
	actions: string[];
	sequence?: number;
};

/** Exact provider label/category identity used by routing operations. */
export type MailLabel = {
	id: string;
	name: string;
	color?: string;
	type?: "category" | "label";
};

/** Provider metadata without a full body; raw selectors and sender text require packet/public redaction. */
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

/** Synthetic or explicitly loaded mailbox data for local workflows. */
export type MailDataset = {
	folders: MailFolder[];
	filters: MailRule[];
	messages: MailMessageSummary[];
};

/** The limit caps total yielded messages; folder IDs and names remain exact private selectors. */
export type ListMessagesInput = {
	folderId?: string;
	folderName?: string;
	limit: number;
};

/** Creates one provider destination, preserving its exact reviewed name. */
export type CreateMailFolderInput = {
	name: string;
	type?: "folder" | "label";
};

/** Provider-specific reviewed policy: Proton uses Sieve; Gmail uses criteria and action. */
export type CreateMailFilterInput = {
	name: string;
	sieve?: string;
	criteria?: Record<string, unknown>;
	action?: Record<string, unknown>;
	enabled?: boolean;
};

/** Targets an existing private rule ID with the reviewed provider-specific policy. */
export type UpdateMailFilterInput = CreateMailFilterInput & {
	id: string;
};

/** Optional methods describe provider capabilities; callers must review mutations before invoking them. */
export interface MailProviderClient {
	provider: MailProvider;
	/** Lists exact private folder identities, including provider hierarchy when available. */
	listFolders(): Promise<MailFolder[]>;
	/** Lists exact label/category identities when the provider supports them. */
	listLabels?(): Promise<MailLabel[]>;
	/** Creates the reviewed destination; unsupported providers omit this capability. */
	createFolder?(input: CreateMailFolderInput): Promise<MailFolder>;
	/** Renames a folder selected by its private ID. */
	renameFolder?(input: {
		id: string;
		displayName: string;
	}): Promise<MailFolder>;
	/** Relocates a folder by ID; provider-specific root selectors are accepted by the adapter. */
	moveFolder?(input: {
		id: string;
		destinationId: string;
	}): Promise<MailFolder>;
	/** Returns policy metadata for review; keep private policy text out of model output. */
	listFilters(): Promise<MailRule[]>;
	/** Creates a reviewed policy using the provider's supported filter representation. */
	createFilter?(input: CreateMailFilterInput): Promise<MailRule>;
	/** Updates a reviewed existing policy by ID; adapters must preserve untouched fields. */
	updateFilter?(input: UpdateMailFilterInput): Promise<MailRule>;
	/** Deletes the selected rule only after the workflow has authorized the change. */
	deleteFilter?(input: { id: string }): Promise<void>;
	/** Collects up to the total limit into memory; use the stream for bounded processing. */
	listMessages(input: ListMessagesInput): Promise<MailMessageSummary[]>;
	/** Yields lazy provider pages; returning early stops fetches and the total limit never changes page offsets. */
	listMessagesStream?(
		input: ListMessagesInput,
	): AsyncIterable<MailMessageSummary[]>;
	/** Moves selected messages; label-based providers may require unlabelMessages for the source. */
	moveMessages(input: {
		messageIds: string[];
		targetFolderId: string;
	}): Promise<void>;
	/** Removes the reviewed source label without deleting the message. */
	unlabelMessages?(input: {
		messageIds: string[];
		labelId: string;
	}): Promise<void>;
	/** Applies explicit handled-message read intent to the selected private IDs. */
	markMessagesRead(input: { messageIds: string[] }): Promise<void>;
	/** Releases owned resources when the provider needs cleanup. */
	close?(): Promise<void>;
}
