import type { AppConfig } from "../config/types";
import { htmlToText } from "../mail/html-text";
import { stripQuotedHistory } from "../mail/quote-strip";
import type {
	MailAccessClient,
	MailAttachment,
	MailDraftInput,
	MailMessage,
	MailPage,
	MailQuery,
	MailReplyDraftInput,
} from "../mail/types";
import { fromDomain } from "../privacy/redact";
import type { InboxRuntime } from "../runtime";
import {
	EnvironmentMicrosoftTokenProvider,
	type MicrosoftTokenProvider,
} from "./auth";
import { GraphHttpTransport, type GraphTransportInput } from "./graph-client";
import type { GraphAttachment, GraphBody, GraphCollection, GraphMessage } from "./types";

const DRAFT_NOT_FOUND = "draft was already sent or is not a draft";
const PAGE_WITH_SEARCH_ERROR =
	"--page is not supported with search; narrow --query or raise --limit";
const PREFER_TEXT_BODY = 'outlook.body-content-type="text"';
const LIST_SELECT =
	"id,from,subject,bodyPreview,receivedDateTime,isRead,hasAttachments,parentFolderId";
const MESSAGE_SELECT =
	"id,from,toRecipients,ccRecipients,subject,receivedDateTime,isRead,parentFolderId,hasAttachments,body,uniqueBody";
const DRAFT_SELECT =
	"id,subject,toRecipients,ccRecipients,body,isDraft,from,hasAttachments";
const ATTACHMENT_SELECT = "id,name,contentType,size,isInline";

const FOLDER_ID_MAP: Record<string, string> = {
	inbox: "inbox",
	drafts: "drafts",
	archive: "archive",
	sent: "sentitems",
	trash: "deleteditems",
	spam: "junkemail",
};

function graphFolderId(folderId: string): string {
	return FOLDER_ID_MAP[folderId.toLowerCase()] ?? folderId;
}

function escapeODataString(value: string): string {
	return value.replace(/'/g, "''");
}

function escapeSearchText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildListFilter(query: MailQuery): string {
	const clauses = [`receivedDateTime ge ${query.since ?? "1970-01-01T00:00:00Z"}`];
	if (query.unread) clauses.push("isRead eq false");
	if (query.from?.includes("@"))
		clauses.push(`from/emailAddress/address eq '${escapeODataString(query.from)}'`);
	if (query.subject)
		clauses.push(`contains(subject,'${escapeODataString(query.subject)}')`);
	return clauses.join(" and ");
}

function graphAddressToString(address?: { name?: string; address?: string }): string {
	if (!address?.address) return "";
	return address.name ? `${address.name} <${address.address}>` : address.address;
}

function toGraphEmailAddress(value: string): { emailAddress: { address: string } } {
	return { emailAddress: { address: value } };
}

function graphBodyToText(body?: GraphBody): string {
	if (!body) return "";
	return body.contentType === "html" ? htmlToText(body.content) : body.content;
}

/** Microsoft Graph adapter for mail read, draft, and send; reuses `GraphHttpTransport` for HTTP plumbing. */
export class GraphMailAccessClient implements MailAccessClient {
	private readonly config: AppConfig;
	private readonly http: GraphHttpTransport;

	constructor(input: GraphTransportInput) {
		this.config = input.config;
		this.http = new GraphHttpTransport(input);
	}

	async listMessages(query: MailQuery): Promise<MailPage> {
		const folderId = graphFolderId(query.folderId || "inbox");
		const params = new URLSearchParams();
		params.set("$select", LIST_SELECT);
		params.set("$orderby", "receivedDateTime desc");
		params.set("$filter", buildListFilter(query));
		params.set("$top", String(query.limit));
		params.set("$skip", String(query.page * query.limit));
		const path = `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${params.toString()}`;
		const { items, hasMore } = await this.http.fetchPage<GraphMessage>(
			path,
			this.config.outlook.scopes.read,
			query.limit,
		);
		const narrowed = this.narrowByDomain(items, query.from);
		return {
			messages: narrowed.map((message) => this.toListMessage(message, folderId)),
			hasMore,
		};
	}

	async searchMessages(query: MailQuery): Promise<MailPage> {
		if (query.page > 0) throw new Error(PAGE_WITH_SEARCH_ERROR);
		const folderId = query.folderId ? graphFolderId(query.folderId) : undefined;
		const path = folderId
			? `/me/mailFolders/${encodeURIComponent(folderId)}/messages`
			: "/me/messages";
		const params = new URLSearchParams();
		params.set("$search", `"${escapeSearchText(query.text ?? "")}"`);
		params.set("$select", LIST_SELECT);
		params.set("$top", String(query.limit));
		const raw = (await this.http.fetchJson(
			`${path}?${params.toString()}`,
			this.config.outlook.scopes.read,
		)) as GraphCollection<GraphMessage>;
		if (!Array.isArray(raw.value))
			throw new Error("Microsoft Graph returned a malformed collection response.");
		return {
			messages: raw.value.map((message) => this.toListMessage(message, folderId ?? "")),
			hasMore: Boolean(raw["@odata.nextLink"]),
		};
	}

	async getMessage(id: string): Promise<MailMessage> {
		const raw = await this.fetchMessageWithTextBody(id, MESSAGE_SELECT);
		const attachments = raw.hasAttachments ? await this.listAttachments(id) : [];
		return this.toMailMessage(raw, attachments);
	}

	async listAttachments(id: string): Promise<MailAttachment[]> {
		const path = `/me/messages/${encodeURIComponent(id)}/attachments?$select=${ATTACHMENT_SELECT}`;
		const { items } = await this.http.fetchPage<GraphAttachment>(
			path,
			this.config.outlook.scopes.read,
			Number.POSITIVE_INFINITY,
		);
		return items.map((attachment) => ({
			id: attachment.id,
			name: attachment.name,
			contentType: attachment.contentType,
			size: attachment.size,
			isInline: attachment.isInline,
		}));
	}

	async createDraft(input: MailDraftInput): Promise<MailMessage> {
		const body = {
			subject: input.subject,
			body: { contentType: "Text", content: input.text },
			toRecipients: input.to.map(toGraphEmailAddress),
			ccRecipients: input.cc.map(toGraphEmailAddress),
		};
		const draft = (await this.http.fetchJson("/me/messages", this.config.outlook.scopes.write, {
			method: "POST",
			body: JSON.stringify(body),
		})) as GraphMessage;
		return this.toMailMessage(draft);
	}

	async createReplyDraft(input: MailReplyDraftInput): Promise<MailMessage> {
		const scopes = this.config.outlook.scopes.write;
		const endpoint = input.replyAll ? "createReplyAll" : "createReply";
		const draft = (await this.http.fetchJson(
			`/me/messages/${encodeURIComponent(input.messageId)}/${endpoint}`,
			scopes,
			{ method: "POST" },
		)) as GraphMessage;
		const cc = [...(draft.ccRecipients ?? []), ...input.cc.map(toGraphEmailAddress)];
		const patched = (await this.http.fetchJson(
			`/me/messages/${encodeURIComponent(draft.id)}`,
			scopes,
			{
				method: "PATCH",
				body: JSON.stringify({
					body: { contentType: "Text", content: input.text },
					ccRecipients: cc,
				}),
			},
		)) as GraphMessage;
		return this.toMailMessage({ ...draft, ...patched });
	}

	async getDraft(id: string): Promise<MailMessage> {
		const raw = await this.fetchMessageWithTextBody(id, DRAFT_SELECT);
		if (raw.isDraft === false) throw new Error(DRAFT_NOT_FOUND);
		const attachments = raw.hasAttachments ? await this.listAttachments(id) : [];
		return this.toMailMessage(raw, attachments);
	}

	async sendDraft(id: string): Promise<void> {
		await this.http.fetchJson(
			`/me/messages/${encodeURIComponent(id)}/send`,
			this.config.outlook.scopes.send,
			{ method: "POST" },
		);
	}

	private async fetchMessageWithTextBody(id: string, select: string): Promise<GraphMessage> {
		return (await this.http.fetchJson(
			`/me/messages/${encodeURIComponent(id)}?$select=${select}`,
			this.config.outlook.scopes.read,
			{ headers: { Prefer: PREFER_TEXT_BODY } },
		)) as GraphMessage;
	}

	private narrowByDomain(messages: GraphMessage[], from?: string): GraphMessage[] {
		if (!from || from.includes("@")) return messages;
		const wanted = from.toLowerCase();
		return messages.filter((message) => {
			const address = graphAddressToString(
				message.from?.emailAddress ?? message.sender?.emailAddress,
			);
			return fromDomain(address).toLowerCase() === wanted;
		});
	}

	private toListMessage(raw: GraphMessage, folderIdFallback: string): MailMessage {
		return {
			id: raw.id,
			from: graphAddressToString(raw.from?.emailAddress ?? raw.sender?.emailAddress),
			to: [],
			cc: [],
			subject: raw.subject ?? "",
			receivedAt: raw.receivedDateTime ?? "",
			folderId: raw.parentFolderId ?? folderIdFallback,
			isRead: raw.isRead ?? false,
			hasAttachments: raw.hasAttachments ?? false,
			text: raw.bodyPreview ?? "",
			attachments: [],
		};
	}

	private toMailMessage(raw: GraphMessage, attachments: MailAttachment[] = []): MailMessage {
		const text = graphBodyToText(raw.body);
		const uniqueText = raw.uniqueBody
			? graphBodyToText(raw.uniqueBody)
			: stripQuotedHistory(text).text;
		return {
			id: raw.id,
			from: graphAddressToString(raw.from?.emailAddress ?? raw.sender?.emailAddress),
			to: (raw.toRecipients ?? []).map((entry) => graphAddressToString(entry.emailAddress)),
			cc: (raw.ccRecipients ?? []).map((entry) => graphAddressToString(entry.emailAddress)),
			subject: raw.subject ?? "",
			receivedAt: raw.receivedDateTime ?? new Date().toISOString(),
			folderId: raw.parentFolderId ?? "",
			isRead: raw.isRead ?? false,
			hasAttachments: raw.hasAttachments ?? false,
			text,
			uniqueText,
			attachments,
		};
	}
}

/** Builds the live Graph-backed client; `_runtime` is unused because auth state binds to `config` directly. */
export function createOutlookMailAccessClient(
	config: AppConfig,
	_runtime: InboxRuntime,
): MailAccessClient {
	const tokenProvider: MicrosoftTokenProvider = new EnvironmentMicrosoftTokenProvider(config);
	return new GraphMailAccessClient({ config, tokenProvider });
}
