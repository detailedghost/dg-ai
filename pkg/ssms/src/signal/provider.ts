import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { assertDraftProvider, readDraft, writeDraft } from "../drafts/store";
import { ConfirmationRequired, HookSendRefused } from "../errors";
import { nextGapMs, timeoutSeconds, type Rng } from "../pace/jitter";
import { withCapabilities } from "../provider";
import type { Logger } from "../privacy/log";
import type {
	CapabilityMap,
	Conversation,
	DraftRecord,
	SmsMessage,
	SmsProvider,
} from "../types";
import { accountIdFrom, envelopesFrom, stripAccountNumber } from "./envelope";
import { appendJournal, readIndex, readJournal, recentMessages, writeIndex } from "./journal";
import type { RpcTransport } from "./rpc";

export const SIGNAL_CAPABILITIES: CapabilityMap = {
	link: true,
	status: true,
	listConversations: true,
	readRecent: true,
	receive: true,
	archive: false,
	blockAndReportSpam: false,
	draftReply: true,
	sendDraft: true,
	reactions: true,
	attachments: true,
	quotes: true,
};

export const DEFAULT_DEVICE_NAME = "dg-cli";

function fileSha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pinAttachments(
	items: { path: string; contentType: string; sha256?: string }[] | undefined,
) {
	return (items ?? []).map((item) => ({ ...item, sha256: fileSha256(item.path) }));
}

function assertAttachmentUnchanged(item: { path: string; sha256?: string }): void {
	const current = fileSha256(item.path);
	if (!item.sha256 || current !== item.sha256) {
		throw new Error("attachment changed since the draft was approved");
	}
}

function rows(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
}

function accountsFrom(value: unknown): string[] {
	return rows(value).flatMap((row) => {
		const id = accountIdFrom(stripAccountNumber(row));
		return id ? [id] : [];
	});
}

function conversationsFrom(contacts: unknown, groups: unknown): Conversation[] {
	const people = rows(contacts).flatMap((row) => {
		const id = typeof row.uuid === "string" ? row.uuid : typeof row.aci === "string" ? row.aci : "";
		if (!id) return [];
		const title =
			(typeof row.name === "string" && row.name) ||
			(typeof row.profileName === "string" && row.profileName) ||
			id;
		return [
			{
				id,
				title,
				preview: "",
				pinned: false,
				savedContact: row.blocked !== true,
				ageDays: 0,
				kind: "dm" as const,
			},
		];
	});
	const rooms = rows(groups).flatMap((row) => {
		const id = typeof row.id === "string" ? row.id : "";
		if (!id) return [];
		return [
			{
				id,
				title: typeof row.name === "string" && row.name ? row.name : id,
				preview: "",
				pinned: false,
				savedContact: false,
				ageDays: 0,
				kind: "group" as const,
			},
		];
	});
	return [...people, ...rooms];
}

export function createSignalProvider(input: {
	home: string;
	rpc: RpcTransport;
	accountId?: string;
	log?: Logger;
	now?: () => number;
	rng?: Rng;
	ids?: () => string;
	callTimeoutMs?: number;
}): SmsProvider {
	const log = input.log ?? (() => undefined);
	const now = input.now ?? (() => Date.now());
	const rng = input.rng ?? Math.random;
	const ids = input.ids ?? (() => crypto.randomUUID());
	const callTimeoutMs = input.callTimeoutMs ?? 120_000;
	const gaps: number[] = [];
	let accountId = input.accountId;

	async function account(): Promise<string> {
		if (accountId) return accountId;
		const listed = accountsFrom(await input.rpc.call("listAccounts", {}, callTimeoutMs));
		accountId = listed[0];
		if (!accountId) throw new Error("signal account is not linked");
		return accountId;
	}

	return withCapabilities("signal", SIGNAL_CAPABILITIES, {
		async link(request) {
			const deviceName = request.deviceName?.trim() || DEFAULT_DEVICE_NAME;
			const started = await input.rpc.call("startLink", {}, callTimeoutMs);
			const uri =
				started && typeof started === "object" && "deviceLinkUri" in started
					? String((started as { deviceLinkUri: unknown }).deviceLinkUri)
					: "";
			if (!uri.startsWith("sgnl://")) throw new Error("signal-cli did not return a linking URI");
			await request.onUri?.(uri);
			const finished = await input.rpc.call(
				"finishLink",
				{ deviceLinkUri: uri, deviceName },
				callTimeoutMs,
			);
			const linkedId = accountIdFrom(finished) ?? "";
			if (linkedId) accountId = linkedId;
			log({ id: linkedId || "signal", reason: "link-uri", provider: "signal", verb: "link" });
			return {
				linked: linkedId.length > 0,
				accountId: linkedId,
				state: linkedId ? ("linked" as const) : ("unknown" as const),
				reason: "link-uri",
				deviceName,
				uri,
			};
		},
		async status() {
			const ids = accountsFrom(await input.rpc.call("listAccounts", {}, callTimeoutMs));
			const linked = ids.length > 0;
			log({
				id: ids[0] ?? "signal",
				reason: linked ? "linked" : "not-linked",
				provider: "signal",
				verb: "status",
			});
			return {
				linked,
				accountIds: ids,
				state: linked ? ("linked" as const) : ("unknown" as const),
				reason: linked ? "linked" : "not-linked",
			};
		},
		async listConversations() {
			const id = await account();
			const contacts = await input.rpc.call(
				"listContacts",
				{ account: id, allRecipients: true },
				callTimeoutMs,
			);
			const groups = await input.rpc.call("listGroups", { account: id }, callTimeoutMs);
			const conversations = conversationsFrom(contacts, groups);
			writeIndex(input.home, conversations);
			log({ id: String(conversations.length), reason: "list", provider: "signal", verb: "list" });
			return conversations;
		},
		async readRecent(conversationId, limit) {
			const messages = recentMessages(readJournal(input.home), conversationId, limit);
			log({ id: conversationId, reason: "read", provider: "signal", verb: "read" });
			return messages;
		},
		async receive(request) {
			const id = await account();
			const gap = nextGapMs(rng, gaps);
			gaps.push(gap);
			const result = await input.rpc.call(
				"receive",
				{
					account: id,
					timeout: timeoutSeconds(gap),
					maxMessages: request.limit,
				},
				Math.max(callTimeoutMs, request.timeoutMs),
			);
			const notes = input.rpc.drainNotifications().flatMap((note) =>
				note.method === "receive" ? envelopesFrom(note.params) : [],
			);
			const incoming = [...envelopesFrom(result), ...notes].slice(0, request.limit);
			const stored = appendJournal(input.home, incoming);
			log({ id: String(stored.length), reason: "receive", provider: "signal", verb: "receive" });
			return stored.slice(0, request.limit);
		},
		async archive() {
			throw new Error("unreachable");
		},
		async blockAndReportSpam() {
			throw new Error("unreachable");
		},
		async draftReply(request) {
			const draft: DraftRecord = {
				id: ids(),
				provider: "signal",
				conversationId: request.conversationId,
				text: request.text,
				emoji: request.emoji,
				remove: request.remove,
				targetTimestamp: request.targetTimestamp,
				targetAuthorId: request.targetAuthorId,
				attachments: pinAttachments(request.attachments),
				quote: request.quote,
				createdAt: new Date(now()).toISOString(),
				status: "pending",
			};
			writeDraft(input.home, draft);
			log({ id: draft.id, reason: "draft", provider: "signal", verb: "draft" });
			return draft;
		},
		async sendDraft(request) {
			if (request.hook) throw new HookSendRefused();
			if (!request.confirmed) throw new ConfirmationRequired();
			const draft = readDraft(input.home, request.draftId);
			assertDraftProvider(draft, "signal");
			const id = await account();
			const known = readIndex(input.home).find((item) => item.id === draft.conversationId);
			const group = known?.kind === "group";
			const target: Record<string, unknown> = { account: id };
			if (group) target.groupId = draft.conversationId;
			else target.recipient = [draft.conversationId];
			if (draft.emoji) {
				await input.rpc.call(
					"sendReaction",
					{
						...target,
						emoji: draft.emoji,
						targetAuthor: draft.targetAuthorId,
						targetTimestamp: draft.targetTimestamp,
						remove: draft.remove === true,
					},
					callTimeoutMs,
				);
			} else {
				for (const attachment of draft.attachments) assertAttachmentUnchanged(attachment);
				await input.rpc.call(
					"send",
					{
						...target,
						message: draft.text ?? "",
						attachment: draft.attachments.map((item) => item.path),
						...(draft.quote
							? {
									quoteTimestamp: draft.quote.timestamp,
									quoteAuthor: draft.quote.authorId,
									quoteMessage: draft.quote.text ?? "",
								}
							: {}),
					},
					callTimeoutMs,
				);
			}
			writeDraft(input.home, { ...draft, status: "sent" });
			log({ id: draft.id, reason: "send", provider: "signal", verb: "send" });
			return { draftId: draft.id, reason: "sent" as const };
		},
	});
}
