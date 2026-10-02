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
/** Proton provider over an injected authenticated extension transport; no browser process or credentials are owned. */
export class ExtensionProtonMailClient implements MailProviderClient {
	readonly provider = "protonmail" as const;
	/** Uses private Proton tab/account configuration and the host's validated browser-request callback. */
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
	/** Returns exact provider folder identities for private routing and inventory. */
	async listFolders(): Promise<MailFolder[]> {
		return (
			(await this.request({ operation: "list-folders" })).folders?.map(
				(folder) => ({ ...folder, type: folder.type ?? "label" }),
			) ?? []
		);
	}
	/** Loads complete private Sieve policies for safe consolidation; public output must scrub policy text. */
	async listFilters() {
		return (await this.request({ operation: "list-filters" })).filters ?? [];
	}
	/** Creates a reviewed Proton folder or label using the extension's fixed operation. */
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
	/** Creates a reviewed non-empty Sieve policy through the selected Proton account. */
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
	/** Updates a private rule ID; the extension rereads its policy and preserves omitted fields. */
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
	/** Completes without closing the user's browser or the host-owned relay. */
	async close(): Promise<void> {}
	/** Deletes the reviewed rule ID through the selected account. */
	async deleteFilter(input: { id: string }) {
		await this.request({ operation: "delete-filter", ...input });
	}
	/** Collects the limited stream into memory; prefer listMessagesStream for large mailboxes. */
	async listMessages(input: ListMessagesInput): Promise<MailMessageSummary[]> {
		const messages: MailMessageSummary[] = [];
		for await (const page of this.listMessagesStream(input))
			messages.push(...page);
		return messages;
	}
	/** Fetches fixed-size pages only on demand, honors the total limit, and stops when the consumer returns. */
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
		let emptyPages = 0;
		for (let page = 0; emitted < input.limit; page++) {
			const response = await this.request({
				operation: "list-messages",
				page,
				pageSize,
				folderId: input.folderId ?? input.folderName,
			});
			const rows = response.messages ?? [];
			const fresh = rows.filter((row) => {
				if (seen.has(row.id)) return false;
				seen.add(row.id);
				return true;
			});
			const chunk = fresh.slice(0, input.limit - emitted);
			if (chunk.length) {
				emitted += chunk.length;
				yield chunk;
			}
			if (
				response.hasMore === false ||
				(response.hasMore === undefined && rows.length < pageSize)
			)
				return;
			if (rows.length && !fresh.length)
				throw new Error("Proton paging stalled: page added no new messages");
			emptyPages = rows.length ? 0 : emptyPages + 1;
			if (emptyPages >= 3)
				throw new Error("Proton paging stalled: consecutive empty pages");
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
	/** Moves messages in bounded extension batches; partial item failures reject the operation. */
	async moveMessages(input: { messageIds: string[]; targetFolderId: string }) {
		await this.mutate("move-messages", input.messageIds, {
			targetFolderId: input.targetFolderId,
		});
	}
	/** Marks selected private message IDs read after explicit workflow read intent. */
	async markMessagesRead(input: { messageIds: string[] }) {
		await this.mutate("mark-read", input.messageIds);
	}
	/** Removes a reviewed label/source folder from selected messages without deleting them. */
	async unlabelMessages(input: { messageIds: string[]; labelId: string }) {
		await this.mutate("unlabel-messages", input.messageIds, {
			labelId: input.labelId,
		});
	}
}
