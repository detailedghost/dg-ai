import { createHash } from "node:crypto";
import { CHAT_MAX_MESSAGE_BODY_BYTES } from "@dg/common";
import { readCappedStdin } from "@dg/common/node";
import { getBooleanFlag, getListFlag, getNumberFlag, getStringFlag, type CliFlags } from "../cli/args";
import { type CliContext, workspaceDirForContext } from "../cli/context";
import { printJson } from "../cli/output";
import { hashId } from "../privacy/hash";
import { fromDomain, redactBodyText, redactText } from "../privacy/redact";
import { inboxRuntimeFor } from "../runtime";
import { createMailAccessClient } from "./factory";
import { htmlToText } from "./html-text";
import { rememberIds, resolveId } from "./ids";
import { stripQuotedHistory } from "./quote-strip";
import type { MailMessage, MailQuery } from "./types";

const UNKNOWN_MESSAGE_ID = "unknown message id; run mail list or mail search first";
const SINCE_RELATIVE = /^(\d+)d$/;
const FOLDER_DISPLAY_NAMES: Record<string, string> = {
	inbox: "Inbox",
	archive: "Archive",
	drafts: "Drafts",
	sent: "Sent",
	trash: "Trash",
	spam: "Spam",
};

function folderDisplayName(folderId: string): string {
	return FOLDER_DISPLAY_NAMES[folderId.toLowerCase()] ?? folderId;
}

function senderNameFrom(from: string): string | undefined {
	const match = /^(.*)<[^<>]+>\s*$/.exec(from);
	const name = match?.[1]?.trim();
	return name || undefined;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function requireStringFlag(flags: CliFlags, key: string, message: string): string {
	const value = getStringFlag(flags, key);
	if (!value) throw new Error(message);
	return value;
}

function validateLimit(flags: CliFlags): number {
	const limit = getNumberFlag(flags, "limit", 20);
	if (!Number.isInteger(limit) || limit < 1 || limit > 200)
		throw new Error("--limit must be between 1 and 200");
	return limit;
}

function validatePage(flags: CliFlags): number {
	const page = getNumberFlag(flags, "page", 0);
	if (!Number.isInteger(page) || page < 0)
		throw new Error("--page must be zero or a positive integer");
	return page;
}

function validateMaxChars(flags: CliFlags): number {
	const maxChars = getNumberFlag(flags, "max-chars", 8000);
	if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 65_536)
		throw new Error("--max-chars must be between 1 and 65536");
	return maxChars;
}

function validateWaitSeconds(flags: CliFlags): number {
	const wait = getNumberFlag(flags, "wait", 300);
	if (!Number.isInteger(wait) || wait < 1 || wait > 600)
		throw new Error("--wait must be between 1 and 600");
	return wait;
}

function parseSince(value: string): string {
	const relative = SINCE_RELATIVE.exec(value);
	if (relative) {
		const days = Number(relative[1]);
		return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime()))
		throw new Error(
			`--since must be an ISO date/time or a relative duration like 7d, got "${value}"`,
		);
	return parsed.toISOString();
}

function baseQuery(flags: CliFlags): Omit<MailQuery, "text"> {
	const since = getStringFlag(flags, "since");
	return {
		folderId: getStringFlag(flags, "folder", "inbox"),
		unread: getBooleanFlag(flags, "unread"),
		since: since ? parseSince(since) : undefined,
		from: getStringFlag(flags, "from") || undefined,
		subject: getStringFlag(flags, "subject") || undefined,
		limit: validateLimit(flags),
		page: validatePage(flags),
	};
}

function messageTextPreview(message: MailMessage): string {
	if (message.text && message.text.trim().length > 0) return message.text;
	return message.html ? htmlToText(message.html) : "";
}

function summarizeMessage(message: MailMessage) {
	return {
		id: hashId(message.id),
		fromDomain: fromDomain(message.from),
		senderName: senderNameFrom(message.from),
		subject: message.subject,
		receivedAt: message.receivedAt,
		isRead: message.isRead,
		hasAttachments: message.hasAttachments,
		snippet: redactText(messageTextPreview(message), 120),
	};
}

async function rememberMessageIds(context: CliContext, messages: MailMessage[]): Promise<void> {
	if (messages.length === 0) return;
	await rememberIds(
		workspaceDirForContext(context),
		messages.map((message) => ({ hash: hashId(message.id), id: message.id })),
	);
}

async function resolveMessageId(context: CliContext, hashedId: string): Promise<string> {
	const providerId = await resolveId(workspaceDirForContext(context), hashedId);
	if (!providerId) throw new Error(UNKNOWN_MESSAGE_ID);
	return providerId;
}

async function readDraftBody(flags: CliFlags): Promise<string> {
	const value = getStringFlag(flags, "body-file");
	if (!value)
		throw new Error("draft body must come from --body-file PATH or --body-file -");
	if (value === "-") {
		const piped = await readCappedStdin(CHAT_MAX_MESSAGE_BODY_BYTES);
		if (piped === undefined) throw new Error("draft body from stdin exceeds the size limit");
		return piped;
	}
	return await Bun.file(value).text();
}

export async function mailList(context: CliContext): Promise<void> {
	const flags = context.args.flags;
	const query: MailQuery = baseQuery(flags);
	const client = createMailAccessClient(context.config, inboxRuntimeFor(context.config).runtime);
	const page = await client.listMessages(query);
	await rememberMessageIds(context, page.messages);
	printJson({
		kind: "mail-list",
		provider: context.config.provider,
		folder: { id: query.folderId, name: folderDisplayName(query.folderId ?? "inbox") },
		page: query.page,
		limit: query.limit,
		count: page.messages.length,
		hasMore: page.hasMore,
		messages: page.messages.map(summarizeMessage),
	});
}

export async function mailSearch(context: CliContext): Promise<void> {
	const flags = context.args.flags;
	const queryText = requireStringFlag(flags, "query", "mail search requires --query TEXT");
	const query: MailQuery = { ...baseQuery(flags), text: queryText };
	const client = createMailAccessClient(context.config, inboxRuntimeFor(context.config).runtime);
	const page = await client.searchMessages(query);
	await rememberMessageIds(context, page.messages);
	printJson({
		kind: "mail-search",
		provider: context.config.provider,
		query: redactText(queryText),
		folder: { id: query.folderId, name: folderDisplayName(query.folderId ?? "inbox") },
		page: query.page,
		limit: query.limit,
		count: page.messages.length,
		hasMore: page.hasMore,
		messages: page.messages.map(summarizeMessage),
	});
}

export async function mailRead(context: CliContext): Promise<void> {
	const flags = context.args.flags;
	const hashedId = requireStringFlag(flags, "message", "mail read requires --message ID");
	const providerId = await resolveMessageId(context, hashedId);
	const maxChars = validateMaxChars(flags);
	const fullQuotes = getBooleanFlag(flags, "full-quotes");
	const client = createMailAccessClient(context.config, inboxRuntimeFor(context.config).runtime);
	const message = await client.getMessage(providerId);
	const rawText = messageTextPreview(message);
	const stripped = fullQuotes
		? { text: rawText, removed: false }
		: stripQuotedHistory(rawText);
	const redacted = redactBodyText(stripped.text, maxChars);
	printJson({
		kind: "mail-message",
		id: hashedId,
		from: message.from,
		to: message.to,
		cc: message.cc,
		subject: message.subject,
		receivedAt: message.receivedAt,
		folder: { id: message.folderId, name: folderDisplayName(message.folderId) },
		isRead: message.isRead,
		text: redacted.text,
		truncated: redacted.truncated,
		quotedHistoryRemoved: stripped.removed,
		attachmentCount: message.attachments.length,
	});
}

export async function mailAttachments(context: CliContext): Promise<void> {
	const flags = context.args.flags;
	const hashedId = requireStringFlag(
		flags,
		"message",
		"mail attachments requires --message ID",
	);
	const providerId = await resolveMessageId(context, hashedId);
	const client = createMailAccessClient(context.config, inboxRuntimeFor(context.config).runtime);
	const attachments = await client.listAttachments(providerId);
	printJson({
		kind: "mail-attachments",
		messageId: hashedId,
		attachments: attachments.map((attachment) => ({
			id: attachment.id,
			name: attachment.name,
			contentType: attachment.contentType,
			size: attachment.size,
			isInline: attachment.isInline,
		})),
	});
}

async function mailDraftNew(context: CliContext): Promise<void> {
	const flags = context.args.flags;
	const to = getListFlag(flags, "to") ?? [];
	if (to.length === 0) throw new Error("mail draft new requires --to ADDRESS");
	const cc = getListFlag(flags, "cc") ?? [];
	const subject = getStringFlag(flags, "subject");
	const text = await readDraftBody(flags);
	const client = createMailAccessClient(context.config, inboxRuntimeFor(context.config).runtime);
	const draft = await client.createDraft({ to, cc, subject, text });
	await rememberMessageIds(context, [draft]);
	printJson({
		kind: "mail-draft",
		id: hashId(draft.id),
		provider: context.config.provider,
		folder: "Drafts",
		to: draft.to,
		cc: draft.cc,
		subject: draft.subject,
	});
}

async function mailDraftReply(context: CliContext): Promise<void> {
	const flags = context.args.flags;
	const hashedMessageId = requireStringFlag(
		flags,
		"message",
		"mail draft reply requires --message ID",
	);
	const providerId = await resolveMessageId(context, hashedMessageId);
	const replyAll = getBooleanFlag(flags, "reply-all");
	const cc = getListFlag(flags, "cc") ?? [];
	const text = await readDraftBody(flags);
	const client = createMailAccessClient(context.config, inboxRuntimeFor(context.config).runtime);
	const draft = await client.createReplyDraft({ messageId: providerId, replyAll, cc, text });
	await rememberMessageIds(context, [draft]);
	printJson({
		kind: "mail-draft",
		id: hashId(draft.id),
		provider: context.config.provider,
		folder: "Drafts",
		to: draft.to,
		cc: draft.cc,
		subject: draft.subject,
		inReplyTo: hashedMessageId,
	});
}

export async function mailDraft(context: CliContext): Promise<void> {
	const action = context.args.rest[0];
	if (action === "new") return mailDraftNew(context);
	if (action === "reply") return mailDraftReply(context);
	throw new Error("mail draft supports new or reply");
}

export async function mailSend(context: CliContext): Promise<void> {
	const flags = context.args.flags;
	const hashedDraftId = requireStringFlag(flags, "draft", "mail send requires --draft ID");
	const runtime = inboxRuntimeFor(context.config).runtime;
	if (!runtime.sendApproval) {
		printJson({ kind: "mail-send-refused", reason: "no-approval-channel" });
		process.exitCode = 1;
		return;
	}
	const waitSeconds = validateWaitSeconds(flags);
	const providerId = await resolveMessageId(context, hashedDraftId);
	const client = createMailAccessClient(context.config, runtime);
	const draft = await client.getDraft(providerId);
	const contentHash = sha256Hex(
		JSON.stringify({ to: draft.to, cc: draft.cc, subject: draft.subject, text: draft.text }),
	);
	const decision = await runtime.sendApproval({
		provider: context.config.provider,
		profile: getStringFlag(flags, "account-profile", "default"),
		draftId: hashedDraftId,
		to: draft.to,
		cc: draft.cc,
		subject: draft.subject,
		text: draft.text,
		attachments: draft.attachments.map((attachment) => attachment.name),
		contentHash,
		timeoutMs: waitSeconds * 1000,
	});
	if (!decision.approved) {
		printJson({
			kind: "mail-send-rejected",
			draftId: hashedDraftId,
			decidedAt: decision.decidedAt,
		});
		process.exitCode = 1;
		return;
	}
	await client.sendDraft(providerId);
	printJson({
		kind: "mail-sent",
		draftId: hashedDraftId,
		approval: { by: "extension", decidedAt: decision.decidedAt },
	});
}
