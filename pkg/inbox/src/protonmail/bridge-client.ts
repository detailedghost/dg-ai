import type { InboxProtonBridgeSettings } from "@dg/common";
import type { AppConfig } from "../config/types";
import {
	type MailAccessClient,
	type MailAttachment,
	type MailDraftInput,
	type MailMessage,
	type MailPage,
	type MailQuery,
	type MailReplyDraftInput,
} from "../mail/types";
import { inboxRuntimeFor, type InboxRuntime } from "../runtime";
import { accountProfileSlug } from "../workspace/profile";
import {
	createBridgeImapSession,
	createBridgeSmtpSender,
	structureAttachmentParts,
	type BridgeConnectionOptions,
	type BridgeImapSession,
	type BridgeMessageSummary,
	type BridgeSmtpSender,
} from "./bridge-adapter";
import { composeMimeMessage, parseMimeMessage } from "./mime";

const UNKNOWN_MESSAGE_ID = "unknown message id; run mail list or mail search first";
const DRAFT_NOT_FOUND = "draft was already sent or is not a draft";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_IMAP_PORT = 1143;
const DEFAULT_SMTP_PORT = 1025;

const CANONICAL_TO_BRIDGE: Record<string, string> = {
	inbox: "INBOX",
	drafts: "Drafts",
	sent: "Sent",
	archive: "Archive",
	trash: "Trash",
	spam: "Spam",
};

function canonicalFolderId(path: string): string {
	const lower = path.toLowerCase();
	for (const [canonical, bridgePath] of Object.entries(CANONICAL_TO_BRIDGE)) {
		if (bridgePath.toLowerCase() === lower) return canonical;
	}
	return path;
}

function providerId(mailboxPath: string, uidValidity: string, uid: number): string {
	return `${mailboxPath}:${uidValidity}:${uid}`;
}

function parseProviderId(id: string): {
	mailboxPath: string;
	uidValidity: string;
	uid: number;
} {
	const lastColon = id.lastIndexOf(":");
	const secondLastColon = lastColon < 0 ? -1 : id.lastIndexOf(":", lastColon - 1);
	if (secondLastColon < 0) throw new Error(UNKNOWN_MESSAGE_ID);
	const mailboxPath = id.slice(0, secondLastColon);
	const uidValidity = id.slice(secondLastColon + 1, lastColon);
	const uid = Number(id.slice(lastColon + 1));
	if (!mailboxPath || !uidValidity || !Number.isInteger(uid)) throw new Error(UNKNOWN_MESSAGE_ID);
	return { mailboxPath, uidValidity, uid };
}

type BridgeConnection = {
	session: BridgeImapSession;
	smtp: BridgeSmtpSender;
	username: string;
};

export type BridgeSessionFactories = {
	createSession(options: BridgeConnectionOptions): Promise<BridgeImapSession>;
	createSmtp(options: BridgeConnectionOptions): Promise<BridgeSmtpSender>;
};

const realBridgeFactories: BridgeSessionFactories = {
	createSession: createBridgeImapSession,
	createSmtp: createBridgeSmtpSender,
};

/** Narrows the search-filter half of MailQuery to what the Bridge adapter's search() accepts. */
function searchCriteriaFrom(query: MailQuery) {
	return {
		unread: query.unread,
		since: query.since ? new Date(query.since) : undefined,
		from: query.from,
		subject: query.subject,
		text: query.text,
	};
}

function summaryToMessage(
	folderId: string,
	path: string,
	uidValidity: string,
	summary: BridgeMessageSummary,
): MailMessage {
	return {
		id: providerId(path, uidValidity, summary.uid),
		from: summary.from,
		to: [],
		cc: [],
		subject: summary.subject,
		receivedAt: summary.receivedAt,
		folderId,
		isRead: summary.isRead,
		hasAttachments: summary.hasAttachments,
		text: "",
		attachments: [],
	};
}

/**
 * `MailAccessClient` for Proton Mail over the Bridge's loopback IMAP and SMTP endpoints.
 * `listMessages`/`searchMessages` never fetch a message body: envelope, flags and
 * bodyStructure are enough for the list contract, and fetching 200 bodies per page would be
 * needlessly heavy. `getMessage` is the only verb that pays for a full BODY.PEEK[] fetch.
 */
class BridgeMailAccessClient implements MailAccessClient {
	private connection: Promise<BridgeConnection> | undefined;

	constructor(
		private readonly config: AppConfig,
		private readonly runtime: InboxRuntime,
		private readonly factories: BridgeSessionFactories,
	) {}

	private connect(): Promise<BridgeConnection> {
		if (!this.connection) this.connection = this.openConnection();
		return this.connection;
	}

	private async openConnection(): Promise<BridgeConnection> {
		const { profile: profileName } = inboxRuntimeFor(this.config);
		const profile = await this.runtime.profileGet?.(profileName);
		const bridge: InboxProtonBridgeSettings | undefined = profile?.protonmail;
		const username = bridge?.bridgeUsername;
		if (!username) {
			throw new Error(
				"Proton Bridge username is not configured; run dg-skills inbox profile set --bridge-username <address>",
			);
		}
		const slug = accountProfileSlug(profileName);
		const credentialName = `inbox/protonmail-bridge/${slug}`;
		const password = await this.runtime.credentialGet?.(credentialName);
		if (!password) {
			throw new Error(
				`store the Proton Bridge password first: dg-skills credentials set ${credentialName}`,
			);
		}
		const options: BridgeConnectionOptions = {
			host: bridge?.bridgeHost ?? DEFAULT_HOST,
			imapPort: bridge?.bridgeImapPort ?? DEFAULT_IMAP_PORT,
			smtpPort: bridge?.bridgeSmtpPort ?? DEFAULT_SMTP_PORT,
			username,
			password,
			certFingerprint: bridge?.bridgeCertFingerprint,
			credentialName,
		};
		const session = await this.factories.createSession(options);
		const smtp = await this.factories.createSmtp(options);
		return { session, smtp, username };
	}

	private async resolveFolderPath(session: BridgeImapSession, folderId: string): Promise<string> {
		const canonical = CANONICAL_TO_BRIDGE[folderId.toLowerCase()];
		if (canonical) return canonical;
		const mailboxes = await session.listMailboxes();
		const underFolders = mailboxes.find((entry) => entry.path === `Folders/${folderId}`);
		if (underFolders) return underFolders.path;
		const underLabels = mailboxes.find((entry) => entry.path === `Labels/${folderId}`);
		if (underLabels) return underLabels.path;
		const insensitive = mailboxes.find(
			(entry) => entry.path.toLowerCase() === `folders/${folderId.toLowerCase()}` ||
				entry.path.toLowerCase() === `labels/${folderId.toLowerCase()}`,
		);
		if (insensitive) return insensitive.path;
		throw new Error(`unknown mail folder: ${folderId}`);
	}

	private async listOrSearch(query: MailQuery): Promise<MailPage> {
		const { session } = await this.connect();
		const folderId = query.folderId ?? "inbox";
		const path = await this.resolveFolderPath(session, folderId);
		const mailbox = await session.select(path, { readOnly: true });
		const summaries = (await session.search(path, searchCriteriaFrom(query))).sort((a, b) =>
			b.receivedAt.localeCompare(a.receivedAt),
		);
		const start = query.page * query.limit;
		const page = summaries.slice(start, start + query.limit);
		return {
			messages: page.map((summary) => summaryToMessage(folderId, path, mailbox.uidValidity, summary)),
			hasMore: start + query.limit < summaries.length,
		};
	}

	async listMessages(query: MailQuery): Promise<MailPage> {
		return this.listOrSearch(query);
	}

	async searchMessages(query: MailQuery): Promise<MailPage> {
		return this.listOrSearch(query);
	}

	async getMessage(id: string): Promise<MailMessage> {
		const { session } = await this.connect();
		const { mailboxPath, uidValidity, uid } = parseProviderId(id);
		const mailbox = await session.select(mailboxPath, { readOnly: true });
		if (mailbox.uidValidity !== uidValidity) throw new Error(UNKNOWN_MESSAGE_ID);
		const { source, isRead } = await session.fetchSource(mailboxPath, uid);
		const parsed = await parseMimeMessage(source);
		return {
			id,
			from: parsed.from,
			to: parsed.to,
			cc: parsed.cc,
			subject: parsed.subject,
			receivedAt: parsed.receivedAt,
			folderId: canonicalFolderId(mailboxPath),
			isRead,
			hasAttachments: parsed.attachments.length > 0,
			text: parsed.text,
			html: parsed.html,
			attachments: parsed.attachments,
		};
	}

	async listAttachments(id: string): Promise<MailAttachment[]> {
		const { session } = await this.connect();
		const { mailboxPath, uidValidity, uid } = parseProviderId(id);
		const mailbox = await session.select(mailboxPath, { readOnly: true });
		if (mailbox.uidValidity !== uidValidity) throw new Error(UNKNOWN_MESSAGE_ID);
		const structure = await session.fetchStructure(mailboxPath, uid);
		return structureAttachmentParts(structure).map((part, index) => ({
			id: part.part ?? `part-${index}`,
			name: part.dispositionParameters?.filename ?? part.parameters?.name ?? "attachment",
			contentType: part.type,
			size: part.size ?? 0,
			isInline: part.disposition === "inline",
		}));
	}

	async createDraft(input: MailDraftInput): Promise<MailMessage> {
		const { session, username } = await this.connect();
		const mime = await composeMimeMessage({
			from: username,
			to: input.to,
			cc: input.cc,
			subject: input.subject,
			text: input.text,
		});
		const appended = await session.append("Drafts", mime, ["\\Draft"]);
		const uidValidity = appended.uidValidity ?? (await session.select("Drafts", { readOnly: true })).uidValidity;
		if (appended.uid === undefined) {
			throw new Error("Proton Bridge did not report the appended draft's UID");
		}
		const parsed = await parseMimeMessage(mime);
		return {
			id: providerId("Drafts", uidValidity, appended.uid),
			from: parsed.from,
			to: parsed.to,
			cc: parsed.cc,
			subject: parsed.subject,
			receivedAt: parsed.receivedAt,
			folderId: "drafts",
			isRead: true,
			hasAttachments: false,
			text: parsed.text,
			attachments: [],
		};
	}

	async createReplyDraft(input: MailReplyDraftInput): Promise<MailMessage> {
		const { session, username } = await this.connect();
		const { mailboxPath, uidValidity, uid } = parseProviderId(input.messageId);
		const mailbox = await session.select(mailboxPath, { readOnly: true });
		if (mailbox.uidValidity !== uidValidity) throw new Error(UNKNOWN_MESSAGE_ID);
		const original = await session.fetchHeaders(mailboxPath, uid);
		const to = [original.from];
		const cc = input.replyAll ? [...original.to, ...original.cc, ...input.cc] : input.cc;
		const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
		const references = original.references
			? `${original.references} ${original.messageId ?? ""}`.trim()
			: original.messageId;
		const mime = await composeMimeMessage({
			from: username,
			to,
			cc,
			subject,
			text: input.text,
			inReplyTo: original.messageId,
			references,
		});
		const appended = await session.append("Drafts", mime, ["\\Draft"]);
		const draftUidValidity =
			appended.uidValidity ?? (await session.select("Drafts", { readOnly: true })).uidValidity;
		if (appended.uid === undefined) {
			throw new Error("Proton Bridge did not report the appended draft's UID");
		}
		const parsed = await parseMimeMessage(mime);
		return {
			id: providerId("Drafts", draftUidValidity, appended.uid),
			from: parsed.from,
			to: parsed.to,
			cc: parsed.cc,
			subject: parsed.subject,
			receivedAt: parsed.receivedAt,
			folderId: "drafts",
			isRead: true,
			hasAttachments: false,
			text: parsed.text,
			attachments: [],
		};
	}

	async getDraft(id: string): Promise<MailMessage> {
		const { mailboxPath } = parseProviderId(id);
		if (mailboxPath.toLowerCase() !== "drafts") throw new Error(DRAFT_NOT_FOUND);
		return this.getMessage(id);
	}

	async sendDraft(id: string): Promise<void> {
		const { session, smtp } = await this.connect();
		const { mailboxPath, uidValidity, uid } = parseProviderId(id);
		if (mailboxPath.toLowerCase() !== "drafts") throw new Error(DRAFT_NOT_FOUND);
		const mailbox = await session.select(mailboxPath, { readOnly: true });
		if (mailbox.uidValidity !== uidValidity) throw new Error(UNKNOWN_MESSAGE_ID);
		const { source } = await session.fetchSource(mailboxPath, uid);
		const parsed = await parseMimeMessage(source);
		await smtp.send(source, { from: parsed.from, to: [...parsed.to, ...parsed.cc] });
		await session.deleteByUid(mailboxPath, uid);
	}

	async close(): Promise<void> {
		if (!this.connection) return;
		const { session, smtp } = await this.connection;
		await session.close();
		await smtp.close();
	}
}

/** Keep the export name `factory.ts` imports; the stub this slice replaces threw synchronously. */
export function createProtonBridgeMailAccessClient(
	config: AppConfig,
	runtime: InboxRuntime,
): MailAccessClient {
	return new BridgeMailAccessClient(config, runtime, realBridgeFactories);
}

/** Test seam: builds the same client over fake sessions instead of real imapflow/nodemailer connections. */
export function createProtonBridgeMailAccessClientWithFactories(
	config: AppConfig,
	runtime: InboxRuntime,
	factories: BridgeSessionFactories,
): MailAccessClient {
	return new BridgeMailAccessClient(config, runtime, factories);
}
