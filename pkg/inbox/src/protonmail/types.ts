export type ProtonFolder = {
	id: string;
	name: string;
	type: "folder" | "label" | "system";
	path?: string;
	total?: number;
	unread?: number;
};

export type ProtonFilter = {
	id: string;
	name: string;
	enabled: boolean;
	conditions: string[];
	actions: string[];
};

export type CreateProtonFilterInput = {
	name: string;
	sieve: string;
	enabled?: boolean;
};

export type CreateProtonFolderInput = {
	name: string;
	type?: "folder" | "label";
};

export type UpdateProtonFilterInput = {
	id: string;
	name: string;
	sieve: string;
	enabled?: boolean;
};

export type ProtonMessageSummary = {
	id: string;
	from: string;
	senderName?: string;
	subject: string;
	snippet: string;
	folderId: string;
	folderName?: string;
	read?: boolean;
	receivedAt?: string;
};

export type ProtonDataset = {
	folders: ProtonFolder[];
	filters: ProtonFilter[];
	messages: ProtonMessageSummary[];
};

export type ListMessagesInput = {
	folderId?: string;
	folderName?: string;
	limit: number;
};

export interface ProtonMailClient {
	listFolders(): Promise<ProtonFolder[]>;
	createFolder(input: CreateProtonFolderInput): Promise<ProtonFolder>;
	listFilters(): Promise<ProtonFilter[]>;
	createFilter(input: CreateProtonFilterInput): Promise<ProtonFilter>;
	updateFilter(input: UpdateProtonFilterInput): Promise<ProtonFilter>;
	deleteFilter(input: { id: string }): Promise<void>;
	listMessages(input: ListMessagesInput): Promise<ProtonMessageSummary[]>;
	moveMessages(input: {
		messageIds: string[];
		targetFolderId: string;
	}): Promise<void>;
	unlabelMessages(input: {
		messageIds: string[];
		labelId: string;
	}): Promise<void>;
	markMessagesRead(input: { messageIds: string[] }): Promise<void>;
	close?(): Promise<void>;
}
