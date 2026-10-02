import type { AppConfig } from "../config/types";
import { redactText } from "../privacy/redact";
import type {
	ListMessagesInput,
	MailFolder,
	MailLabel,
	MailMessageSummary,
	MailProviderClient,
	MailRule,
} from "../providers/types";
import type { MicrosoftTokenProvider } from "./auth";
import type {
	GraphCategory,
	GraphCollection,
	GraphFolder,
	GraphMessage,
	GraphRule,
} from "./types";

type FetchLike = typeof fetch;

export class GraphRestClient implements MailProviderClient {
	readonly provider = "outlook" as const;

	constructor(
		private readonly input: {
			config: AppConfig;
			tokenProvider: MicrosoftTokenProvider;
			fetch?: FetchLike;
		},
	) {}

	async listFolders(): Promise<MailFolder[]> {
		const folders = await this.fetchFoldersRecursive();
		return buildFolderPaths(folders.map(graphFolderToMailFolder));
	}

	async listLabels(): Promise<MailLabel[]> {
		const page = await this.fetchCollection<GraphCategory>(
			"/me/outlook/masterCategories",
			this.input.config.outlook.scopes.rules,
		);
		return page.map(graphCategoryToMailLabel);
	}

	async listFilters(): Promise<MailRule[]> {
		const folders = await this.listFolders();
		const inbox = folders.find(
			(folder) =>
				folder.aliases?.includes("inbox") ||
				folder.name.toLowerCase() === "inbox",
		);
		const folderId = inbox?.id ?? "inbox";
		const page = await this.fetchCollection<GraphRule>(
			`/me/mailFolders/${encodeURIComponent(folderId)}/messageRules`,
			this.input.config.outlook.scopes.rules,
		);
		return page.map(graphRuleToMailRule);
	}

	async listMessages(input: ListMessagesInput): Promise<MailMessageSummary[]> {
		const messages: MailMessageSummary[] = [];
		for await (const page of this.listMessagesStream(input)) {
			messages.push(...page);
		}
		return messages;
	}

	async *listMessagesStream(
		input: ListMessagesInput,
	): AsyncGenerator<MailMessageSummary[]> {
		const folderId = input.folderId || input.folderName || "inbox";
		const top = Math.max(1, Math.min(this.input.config.outlook.pageSize, 200));
		const select =
			"id,from,sender,subject,bodyPreview,parentFolderId,isRead,receivedDateTime,categories";
		const start = `/me/mailFolders/${encodeURIComponent(folderId)}/messages?$select=${select}&$top=${top}&$orderby=receivedDateTime desc`;
		for await (const page of this.fetchCollectionStream<GraphMessage>(
			start,
			this.input.config.outlook.scopes.read,
			input.limit,
		)) {
			yield page.map(graphMessageToMailSummary);
		}
	}

	async moveMessages(input: {
		messageIds: string[];
		targetFolderId: string;
	}): Promise<void> {
		for (const chunk of chunked(input.messageIds, 20)) {
			await Promise.all(
				chunk.map((messageId) =>
					this.fetchJson(
						`/me/messages/${encodeURIComponent(messageId)}/move`,
						this.input.config.outlook.scopes.write,
						{
							method: "POST",
							body: JSON.stringify({ destinationId: input.targetFolderId }),
						},
					),
				),
			);
		}
	}

	async markMessagesRead(input: { messageIds: string[] }): Promise<void> {
		for (const chunk of chunked(input.messageIds, 20)) {
			await Promise.all(
				chunk.map((messageId) =>
					this.fetchJson(
						`/me/messages/${encodeURIComponent(messageId)}`,
						this.input.config.outlook.scopes.write,
						{
							method: "PATCH",
							body: JSON.stringify({ isRead: true }),
						},
					),
				),
			);
		}
	}

	async renameFolder(input: {
		id: string;
		displayName: string;
	}): Promise<MailFolder> {
		const folder = (await this.fetchJson(
			`/me/mailFolders/${encodeURIComponent(input.id)}`,
			this.input.config.outlook.scopes.write,
			{
				method: "PATCH",
				body: JSON.stringify({ displayName: input.displayName }),
			},
		)) as GraphFolder;
		return graphFolderToMailFolder(folder);
	}

	async moveFolder(input: {
		id: string;
		destinationId: string;
	}): Promise<MailFolder> {
		// `msgfolderroot` is Graph's well-known id for the top level, so promoting a
		// nested folder to top level is just a move with that destination.
		const folder = (await this.fetchJson(
			`/me/mailFolders/${encodeURIComponent(input.id)}/move`,
			this.input.config.outlook.scopes.write,
			{
				method: "POST",
				body: JSON.stringify({ destinationId: input.destinationId }),
			},
		)) as GraphFolder;
		return graphFolderToMailFolder(folder);
	}

	private async fetchCollection<T>(
		path: string,
		scopes: string[],
		limit = Number.POSITIVE_INFINITY,
	): Promise<T[]> {
		const values: T[] = [];
		for await (const page of this.fetchCollectionStream<T>(
			path,
			scopes,
			limit,
		)) {
			values.push(...page);
		}
		return values;
	}

	private async *fetchCollectionStream<T>(
		path: string,
		scopes: string[],
		limit = Number.POSITIVE_INFINITY,
	): AsyncGenerator<T[]> {
		let next: string | undefined = path;
		let emitted = 0;
		const cursors = new Set<string>();
		const messageIds = new Set<string>();
		while (next && emitted < limit) {
			if (cursors.has(next))
				throw new Error("Microsoft Graph paging stalled: repeated cursor");
			cursors.add(next);
			const page = (await this.fetchJson(next, scopes)) as GraphCollection<T>;
			if (!Array.isArray(page.value)) {
				throw new Error(
					"Microsoft Graph returned a malformed collection response.",
				);
			}
			for (const row of page.value) {
				if (
					typeof row === "object" &&
					row !== null &&
					"id" in row &&
					typeof row.id === "string"
				) {
					if (messageIds.has(row.id))
						throw new Error(
							"Microsoft Graph paging stalled: duplicate message id",
						);
					messageIds.add(row.id);
				}
			}
			const slice = page.value.slice(0, limit - emitted);
			if (slice.length > 0) {
				emitted += slice.length;
				yield slice;
			}
			next = page["@odata.nextLink"];
		}
	}

	private async fetchFoldersRecursive(): Promise<GraphFolder[]> {
		const rootFolders = await this.fetchFolderPage("/me/mailFolders");
		const folders = [...rootFolders];
		const seen = new Set(rootFolders.map((folder) => folder.id));
		const queue = rootFolders.filter(
			(folder) => (folder.childFolderCount ?? 0) > 0,
		);

		while (queue.length > 0) {
			const folder = queue.shift();
			if (!folder) {
				continue;
			}
			const children = await this.fetchFolderPage(
				`/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders`,
			);
			for (const child of children) {
				if (seen.has(child.id)) {
					continue;
				}
				seen.add(child.id);
				folders.push(child);
				if ((child.childFolderCount ?? 0) > 0) {
					queue.push(child);
				}
			}
		}

		return folders;
	}

	private async fetchFolderPage(path: string): Promise<GraphFolder[]> {
		const select =
			"id,displayName,parentFolderId,totalItemCount,unreadItemCount,childFolderCount";
		const separator = path.includes("?") ? "&" : "?";
		return this.fetchCollection<GraphFolder>(
			`${path}${separator}$select=${select}&$top=${this.input.config.outlook.pageSize}`,
			this.input.config.outlook.scopes.read,
		);
	}

	private async fetchJson(
		pathOrUrl: string,
		scopes: string[],
		init: RequestInit = {},
	): Promise<unknown> {
		const base = new URL(this.input.config.outlook.graphBaseUrl);
		const url = new URL(
			pathOrUrl.startsWith("http")
				? pathOrUrl
				: `${this.input.config.outlook.graphBaseUrl}${pathOrUrl}`,
		);
		const prefix = base.pathname.replace(/\/$/, "");
		if (
			url.origin !== base.origin ||
			url.protocol !== "https:" ||
			(prefix && !url.pathname.startsWith(prefix + "/")) ||
			url.username ||
			url.password
		)
			throw new Error("Untrusted Microsoft Graph nextLink origin or path");
		const token = await this.input.tokenProvider.getToken(scopes);
		const fetchImpl = this.input.fetch ?? fetch;
		const headers = new Headers(init.headers);
		headers.set("content-type", "application/json");
		headers.set("accept", "application/json");
		headers.set("authorization", `Bearer ${token.accessToken}`);
		headers.set("Prefer", 'IdType="ImmutableId"');
		let attempt = 0;

		while (true) {
			const response = await fetchImpl(url.toString(), {
				...init,
				redirect: "error",
				headers,
			});

			if (response.ok) {
				const text = await response.text();
				if (!text.trim()) {
					return {};
				}
				return JSON.parse(text);
			}

			if ((response.status === 429 || response.status >= 500) && attempt < 3) {
				attempt += 1;
				await sleep(retryDelayMs(response, attempt));
				continue;
			}

			throw await graphError(response, scopes);
		}
	}
}

function graphFolderToMailFolder(folder: GraphFolder): MailFolder {
	const alias = outlookFolderAlias(folder);
	return {
		id: folder.id,
		name: folder.displayName,
		type: alias ? "system" : "folder",
		parentId: folder.parentFolderId,
		total: folder.totalItemCount,
		unread: folder.unreadItemCount,
		aliases: alias ? [alias] : undefined,
	};
}

function outlookFolderAlias(folder: GraphFolder): string | undefined {
	const knownName = folder.wellKnownName?.toLowerCase();
	if (knownName) {
		return knownName;
	}
	const id = folder.id?.toLowerCase();
	if (wellKnownFolderIds.has(id)) {
		return id;
	}
	const displayName = folder.displayName?.toLowerCase();
	if (wellKnownFolderIds.has(displayName)) {
		return displayName;
	}
	return undefined;
}

const wellKnownFolderIds = new Set([
	"archive",
	"clutter",
	"conflicts",
	"conversationhistory",
	"deleteditems",
	"drafts",
	"inbox",
	"junkemail",
	"localfailures",
	"msgfolderroot",
	"outbox",
	"recoverableitemsdeletions",
	"scheduled",
	"searchfolders",
	"sentitems",
	"serverfailures",
	"syncissues",
]);

function buildFolderPaths(folders: MailFolder[]): MailFolder[] {
	const byId = new Map(folders.map((folder) => [folder.id, folder]));
	return folders.map((folder) => ({
		...folder,
		path: folderPath(folder, byId),
	}));
}

function folderPath(folder: MailFolder, byId: Map<string, MailFolder>): string {
	const names = [folder.name];
	let parent = folder.parentId ? byId.get(folder.parentId) : undefined;
	const seen = new Set([folder.id]);
	while (parent && !seen.has(parent.id)) {
		names.unshift(parent.name);
		seen.add(parent.id);
		parent = parent.parentId ? byId.get(parent.parentId) : undefined;
	}
	return names.join("/");
}

function graphRuleToMailRule(rule: GraphRule): MailRule {
	return {
		id: rule.id,
		name: rule.displayName,
		enabled: rule.isEnabled ?? true,
		sequence: rule.sequence,
		conditions: flattenRulePart(rule.conditions),
		actions: flattenRulePart(rule.actions),
	};
}

function graphCategoryToMailLabel(category: GraphCategory): MailLabel {
	return {
		id: category.id,
		name: category.displayName,
		color: category.color,
		type: "category",
	};
}

function flattenRulePart(value: Record<string, unknown> | undefined): string[] {
	if (!value) {
		return [];
	}
	return Object.entries(value).map(
		([key, item]) => `${key}:${redactText(JSON.stringify(item))}`,
	);
}

function graphMessageToMailSummary(message: GraphMessage): MailMessageSummary {
	const from = message.from?.emailAddress ?? message.sender?.emailAddress;
	const address = from?.address ?? "unknown";
	const name = from?.name;
	return {
		id: message.id,
		from: name ? `${name} <${address}>` : address,
		senderName: name,
		subject: message.subject ?? "",
		snippet: message.bodyPreview ?? "",
		folderId: message.parentFolderId ?? "",
		receivedAt: message.receivedDateTime,
		categories: message.categories,
		isRead: message.isRead,
	};
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

async function graphError(
	response: Response,
	scopes: string[],
): Promise<Error> {
	let code = "";
	try {
		const body = (await response.json()) as { error?: { code?: string } };
		code = "";
	} catch {
		code = "";
	}

	if (response.status === 401) {
		return new Error(
			"Microsoft Graph authentication failed. Re-authenticate the Outlook account; tokens and response bodies were redacted.",
		);
	}
	if (response.status === 403) {
		return new Error(
			`Microsoft Graph denied this request${code}. Required delegated scopes include: ${scopes.join(", ")}.`,
		);
	}
	if (response.status === 429) {
		return new Error(
			"Microsoft Graph throttled this request after retries. Retry later or lower the Outlook page size.",
		);
	}
	return new Error(
		`Microsoft Graph request failed with HTTP ${response.status}${code}. Raw response body was redacted.`,
	);
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
