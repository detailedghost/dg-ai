import {
	INBOX_MAX_PAGE_SIZE,
	INBOX_MAX_MESSAGE_IDS,
	validateInboxBrowserRequest,
	validateInboxBrowserResponse,
	type InboxBrowserRequest,
	type InboxBrowserResponse,
} from "@dg/common";
import type { AppConfig } from "../config/types";
import type {
	MailProviderClient,
	ListMessagesInput,
	MailMessageSummary,
	MailFolder,
	CreateMailFilterInput,
	UpdateMailFilterInput,
} from "../providers/types";
export class ExtensionProtonMailClient implements MailProviderClient {
	readonly provider = "protonmail" as const;
	constructor(
		private readonly input: {
			config: AppConfig;
			browserRequest: (
				request: InboxBrowserRequest,
			) => Promise<InboxBrowserResponse>;
		},
	) {}
	private async request(
		request: InboxBrowserRequest,
	): Promise<InboxBrowserResponse> {
		const target = {
			...request,
			tabId: this.input.config.protonmail.tabId,
			accountHint: this.input.config.protonmail.accountHint,
		};
		return validateInboxBrowserResponse(
			await this.input.browserRequest(validateInboxBrowserRequest(target)),
		);
	}
	async listFolders(): Promise<MailFolder[]> {
		return (
			(await this.request({ operation: "list-folders" })).folders?.map(
				(folder) => ({ ...folder, type: folder.type ?? "label" }),
			) ?? []
		);
	}
	async listFilters() {
		return (await this.request({ operation: "list-filters" })).filters ?? [];
	}
	async createFolder(input: {
		name: string;
		type?: "folder" | "label";
	}): Promise<MailFolder> {
		const folder = (
			await this.request({ operation: "create-folder", ...input })
		).folder;
		if (!folder)
			throw new Error("Proton extension did not return the created folder");
		return { ...folder, type: folder.type ?? "label" };
	}
	async createFilter(input: CreateMailFilterInput) {
		const filter = (
			await this.request({
				operation: "create-filter",
				name: input.name,
				sieve: input.sieve,
				enabled: input.enabled,
			})
		).filter;
		if (!filter)
			throw new Error("Proton extension did not return the created filter");
		return filter;
	}
	async updateFilter(input: UpdateMailFilterInput) {
		const filter = (
			await this.request({
				operation: "update-filter",
				id: input.id,
				name: input.name,
				sieve: input.sieve,
				enabled: input.enabled,
			})
		).filter;
		if (!filter)
			throw new Error("Proton extension did not return the updated filter");
		return filter;
	}
	async close(): Promise<void> {}
	async deleteFilter(input: { id: string }) {
		await this.request({ operation: "delete-filter", ...input });
	}
	async listMessages(input: ListMessagesInput): Promise<MailMessageSummary[]> {
		const messages: MailMessageSummary[] = [];
		for await (const page of this.listMessagesStream(input))
			messages.push(...page);
		return messages;
	}
	async *listMessagesStream(
		input: ListMessagesInput,
	): AsyncGenerator<MailMessageSummary[]> {
		if (input.limit <= 0) return;
		const pageSize = Math.max(
			1,
			Math.min(INBOX_MAX_PAGE_SIZE, this.input.config.protonmail.batchSize),
		);
		let emitted = 0;
		const seen = new Set<string>();
		for (let page = 0; emitted < input.limit; page++) {
			const response = await this.request({
				operation: "list-messages",
				page,
				pageSize,
				folderId: input.folderId ?? input.folderName,
			});
			const rows = response.messages ?? [];
			for (const row of rows) {
				if (seen.has(row.id))
					throw new Error("Proton paging stalled: repeated message id");
				seen.add(row.id);
			}
			const chunk = rows.slice(0, input.limit - emitted);
			if (chunk.length) {
				emitted += chunk.length;
				yield chunk;
			}
			if (
				!rows.length ||
				response.hasMore === false ||
				(response.hasMore === undefined && rows.length < pageSize)
			)
				return;
		}
	}
	private async mutate(
		operation: "move-messages" | "mark-read" | "unlabel-messages",
		messageIds: string[],
		extra: Pick<InboxBrowserRequest, "targetFolderId" | "labelId"> = {},
	) {
		for (let i = 0; i < messageIds.length; i += INBOX_MAX_MESSAGE_IDS)
			await this.request({
				operation,
				messageIds: messageIds.slice(i, i + INBOX_MAX_MESSAGE_IDS),
				...extra,
			});
	}
	async moveMessages(input: { messageIds: string[]; targetFolderId: string }) {
		await this.mutate("move-messages", input.messageIds, {
			targetFolderId: input.targetFolderId,
		});
	}
	async markMessagesRead(input: { messageIds: string[] }) {
		await this.mutate("mark-read", input.messageIds);
	}
	async unlabelMessages(input: { messageIds: string[]; labelId: string }) {
		await this.mutate("unlabel-messages", input.messageIds, {
			labelId: input.labelId,
		});
	}
}
