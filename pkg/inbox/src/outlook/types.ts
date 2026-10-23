import type {
	MailDataset,
	MailFolder,
	MailLabel,
	MailMessageSummary,
	MailRule,
} from "../providers/types";

export type OutlookDataset = MailDataset;
export type OutlookFolder = MailFolder;
export type OutlookMessageSummary = MailMessageSummary;
export type OutlookRule = MailRule;
export type OutlookLabel = MailLabel;

export type GraphCollection<T> = {
	value: T[];
	"@odata.nextLink"?: string;
};

export type GraphFolder = {
	id: string;
	displayName: string;
	parentFolderId?: string;
	totalItemCount?: number;
	unreadItemCount?: number;
	childFolderCount?: number;
	wellKnownName?: string;
};

export type GraphEmailAddress = {
	emailAddress?: {
		name?: string;
		address?: string;
	};
};

export type GraphBody = {
	contentType: "text" | "html";
	content: string;
};

export type GraphMessage = {
	id: string;
	from?: GraphEmailAddress;
	sender?: GraphEmailAddress;
	toRecipients?: GraphEmailAddress[];
	ccRecipients?: GraphEmailAddress[];
	subject?: string;
	bodyPreview?: string;
	body?: GraphBody;
	uniqueBody?: GraphBody;
	parentFolderId?: string;
	isRead?: boolean;
	isDraft?: boolean;
	hasAttachments?: boolean;
	receivedDateTime?: string;
	categories?: string[];
};

export type GraphAttachment = {
	id: string;
	name: string;
	contentType: string;
	size: number;
	isInline: boolean;
};

export type GraphRule = {
	id: string;
	displayName: string;
	isEnabled?: boolean;
	sequence?: number;
	conditions?: Record<string, unknown>;
	actions?: Record<string, unknown>;
};

export type GraphCategory = {
	id: string;
	displayName: string;
	color?: string;
};
