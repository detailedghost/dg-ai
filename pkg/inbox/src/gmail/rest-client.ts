import pMap from "p-map";
import type { AppConfig } from "../config/types";
import { redactText } from "../privacy/redact";
import type {
	ListMessagesInput,
	MailFolder,
	MailMessageSummary,
	MailProviderClient,
	MailRule,
} from "../providers/types";
import type { GoogleTokenProvider } from "./auth";
import type {
	GmailApiFilter,
	GmailApiLabel,
	GmailApiMessage,
	GmailApiMessageListItem,
	GmailListResponse,
} from "./types";

type FetchLike = typeof fetch;

/** Gmail REST metadata adapter with lazy ID pages and bounded metadata concurrency. */
export class GmailRestClient implements MailProviderClient {
	readonly provider = "gmail" as const;

	/** Uses configured delegated scopes, a host token provider, and an optional fetch boundary. */
	constructor(
		private readonly input: {
			config: AppConfig;
			tokenProvider: GoogleTokenProvider;
			fetch?: FetchLike;
		},
	) {}

	/** Returns exact provider folder identities for private routing and inventory. */
	async listFolders(): Promise<MailFolder[]> {
		const response = (await this.fetchJson(
			"/users/me/labels",
			this.input.config.gmail.scopes.read,
		)) as GmailListResponse<GmailApiLabel>;
		if (!Array.isArray(response.labels)) {
			throw new Error("Gmail returned a malformed labels response.");
		}
		return response.labels.map(gmailLabelToFolder);
	}

	/** Creates a Gmail label while preserving its exact reviewed name. */
	async createFolder(input: { name: string }): Promise<MailFolder> {
		return gmailLabelToFolder(
			(await this.fetchJson(
				"/users/me/labels",
				this.input.config.gmail.scopes.modify,
				{
					method: "POST",
					body: JSON.stringify({
						name: input.name,
						labelListVisibility: "labelShow",
						messageListVisibility: "show",
					}),
				},
			)) as GmailApiLabel,
		);
	}

	/** Lists Gmail filter criteria/actions as private review metadata. */
	async listFilters(): Promise<MailRule[]> {
		const response = (await this.fetchJson(
			"/users/me/settings/filters",
			this.input.config.gmail.scopes.settings,
		)) as GmailListResponse<GmailApiFilter>;
		return (response.filter ?? []).map(gmailFilterToRule);
	}

	/** Creates a Gmail settings filter from reviewed criteria and action objects. */
	async createFilter(input: {
		name: string;
		criteria?: Record<string, unknown>;
		action?: Record<string, unknown>;
		enabled?: boolean;
	}): Promise<MailRule> {
		const created = (await this.fetchJson(
			"/users/me/settings/filters",
			this.input.config.gmail.scopes.settings,
			{
				method: "POST",
				body: JSON.stringify({
					criteria: input.criteria ?? {},
					action: input.action ?? {},
				}),
			},
		)) as GmailApiFilter;
		return {
			...gmailFilterToRule(created),
			name: input.name || created.id,
			enabled: input.enabled !== false,
		};
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
		const labelId = input.folderId || input.folderName || "INBOX";
		const pageSize = Math.max(
			1,
			Math.min(500, this.input.config.gmail.pageSize),
		);
		let cursor: string | undefined;
		let emitted = 0;
		const cursors = new Set<string>();
		const ids = new Set<string>();
		do {
			const query = new URLSearchParams({
				labelIds: labelId,
				maxResults: String(pageSize),
			});
			if (cursor) query.set("pageToken", cursor);
			const response = (await this.fetchJson(
				"/users/me/messages?" + query,
				this.input.config.gmail.scopes.read,
			)) as GmailListResponse<GmailApiMessageListItem>;
			const rows = response.messages ?? [];
			if (!Array.isArray(rows))
				throw new Error("Gmail returned a malformed messages response");
			for (const row of rows) {
				if (ids.has(row.id))
					throw new Error("Gmail paging stalled: repeated message id");
				ids.add(row.id);
			}
			const slice = rows.slice(0, input.limit - emitted);
			const metadata = await pMap(
				slice,
				(row) => this.fetchMessageMetadata(row.id, labelId, input.folderName),
				{
					concurrency: Math.max(
						1,
						Math.min(32, this.input.config.gmail.maxConcurrency),
					),
				},
			);
			if (metadata.length) {
				emitted += metadata.length;
				yield metadata;
			}
			cursor = response.nextPageToken;
			if (cursor) {
				if (cursors.has(cursor))
					throw new Error("Gmail paging stalled: repeated cursor");
				cursors.add(cursor);
			}
		} while (cursor && emitted < input.limit);
	}

	/** Adds the destination label in bounded batches; remove the source separately with unlabelMessages. */
	async moveMessages(input: {
		messageIds: string[];
		targetFolderId: string;
	}): Promise<void> {
		for (const chunk of chunked(input.messageIds, 500)) {
			await this.batchModify(chunk, [input.targetFolderId], []);
		}
	}

	/** Removes a reviewed label/source folder from selected messages without deleting them. */
	async unlabelMessages(input: {
		messageIds: string[];
		labelId: string;
	}): Promise<void> {
		for (const chunk of chunked(input.messageIds, 500)) {
			await this.batchModify(chunk, [], [input.labelId]);
		}
	}

	/** Marks selected private message IDs read after explicit workflow read intent. */
	async markMessagesRead(input: { messageIds: string[] }): Promise<void> {
		for (const chunk of chunked(input.messageIds, 500)) {
			await this.batchModify(chunk, [], ["UNREAD"]);
		}
	}

	private async fetchMessageMetadata(
		id: string,
		fallbackFolderId: string,
		fallbackFolderName?: string,
	): Promise<MailMessageSummary> {
		const params = new URLSearchParams({
			format: "metadata",
			metadataHeaders: "From",
		});
		params.append("metadataHeaders", "Subject");
		const message = (await this.fetchJson(
			`/users/me/messages/${encodeURIComponent(id)}?${params.toString()}`,
			this.input.config.gmail.scopes.read,
		)) as GmailApiMessage;
		return gmailMessageToSummary(message, fallbackFolderId, fallbackFolderName);
	}

	private async batchModify(
		ids: string[],
		addLabelIds: string[],
		removeLabelIds: string[],
	): Promise<void> {
		await this.fetchJson(
			"/users/me/messages/batchModify",
			this.input.config.gmail.scopes.modify,
			{
				method: "POST",
				body: JSON.stringify({ ids, addLabelIds, removeLabelIds }),
			},
		);
	}

	private async fetchJson(
		path: string,
		scopes: string[],
		init: RequestInit = {},
	): Promise<unknown> {
		const token = await this.input.tokenProvider.getToken(scopes);
		const url = `${this.input.config.gmail.apiBaseUrl}${path}`;
		const fetchImpl = this.input.fetch ?? fetch;
		let attempt = 0;

		while (true) {
			const response = await fetchImpl(url, {
				...init,
				redirect: "error",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					authorization: `Bearer ${token.accessToken}`,
					...init.headers,
				},
			});

			if (response.ok) {
				if (response.status === 204) {
					return {};
				}
				return response.json();
			}

			if ((response.status === 429 || response.status >= 500) && attempt < 3) {
				attempt += 1;
				await sleep(retryDelayMs(response, attempt));
				continue;
			}

			throw await gmailError(response, scopes);
		}
	}
}

function gmailLabelToFolder(label: GmailApiLabel): MailFolder {
	const alias = systemAlias(label.id, label.name);
	return {
		id: label.id,
		name: label.name,
		path: label.name,
		type: label.type === "system" ? "system" : "label",
		total: label.messagesTotal,
		unread: label.messagesUnread,
		aliases: alias ? [alias] : undefined,
	};
}

function gmailFilterToRule(filter: GmailApiFilter): MailRule {
	return {
		id: filter.id,
		name: filter.id,
		enabled: true,
		conditions: filter.criteria
			? [redactText(JSON.stringify(filter.criteria))]
			: [],
		actions: filter.action ? [redactText(JSON.stringify(filter.action))] : [],
	};
}

function gmailMessageToSummary(
	message: GmailApiMessage,
	fallbackFolderId: string,
	fallbackFolderName?: string,
): MailMessageSummary {
	const headers = new Map(
		(message.payload?.headers ?? []).map((header) => [
			header.name.toLowerCase(),
			header.value,
		]),
	);
	const labelIds = message.labelIds ?? [];
	return {
		id: message.id,
		threadId: message.threadId,
		from: headers.get("from") ?? "unknown",
		subject: headers.get("subject") ?? "",
		snippet: message.snippet ?? "",
		folderId: labelIds[0] ?? fallbackFolderId,
		folderName: fallbackFolderName,
		labels: labelIds,
		read: !labelIds.includes("UNREAD"),
		receivedAt: message.internalDate
			? new Date(Number(message.internalDate)).toISOString()
			: undefined,
	};
}

function systemAlias(id: string, name: string): string | undefined {
	const normalized = (id || name).toLowerCase();
	if (normalized === "inbox") return "inbox";
	if (normalized === "unread") return "unread";
	if (normalized === "sent") return "sent";
	if (normalized === "trash") return "trash";
	if (normalized === "spam") return "spam";
	if (normalized === "starred") return "starred";
	if (normalized === "important") return "important";
	return undefined;
}

async function gmailError(
	response: Response,
	scopes: string[],
): Promise<Error> {
	let reason = "";
	try {
		const body = (await response.json()) as {
			error?: { status?: string; message?: string };
		};
		reason = "";
	} catch {
		reason = "";
	}
	if (response.status === 401) {
		return new Error(
			"Gmail authentication failed. Re-authenticate the Google account; tokens and response bodies were redacted.",
		);
	}
	if (response.status === 403) {
		return new Error(
			`Gmail denied this request${reason}. Required scopes include: ${scopes.join(", ")}.`,
		);
	}
	if (response.status === 429) {
		return new Error(
			"Gmail throttled this request after retries. Retry later or lower Gmail concurrency/page size.",
		);
	}
	return new Error(
		`Gmail request failed with HTTP ${response.status}${reason}. Raw response body was redacted.`,
	);
}

function retryDelayMs(response: Response, attempt: number): number {
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) {
			return Math.min(seconds * 1000, 10_000);
		}
	}
	return Math.min(250 * 2 ** attempt, 2_000);
}

function chunked<T>(values: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
