import type {
	MailDataset,
	MailFolder,
	MailMessageSummary,
	MailRule,
} from "../providers/types";

export type GmailDataset = MailDataset;
export type GmailLabel = MailFolder;
export type GmailMessageSummary = MailMessageSummary;
export type GmailFilter = MailRule;

export type GmailListResponse<T> = {
	labels?: T[];
	filter?: T[];
	messages?: T[];
	nextPageToken?: string;
};

export type GmailApiLabel = {
	id: string;
	name: string;
	type?: "system" | "user";
	messagesTotal?: number;
	messagesUnread?: number;
};

export type GmailApiFilter = {
	id: string;
	criteria?: Record<string, unknown>;
	action?: Record<string, unknown>;
};

export type GmailApiMessageListItem = {
	id: string;
	threadId?: string;
};

export type GmailApiHeader = {
	name: string;
	value: string;
};

export type GmailApiMessage = {
	id: string;
	threadId?: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string;
	payload?: {
		headers?: GmailApiHeader[];
	};
};
