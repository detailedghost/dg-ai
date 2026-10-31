import { scopeDays } from "../config/parse";
import { defaultCleanupConfig, type SmsCleanupConfig } from "../config/types";
import { claimDraft, finishDraft, readDraft, releaseDraft, writeDraft } from "../drafts/store";
import { ConfirmationRequired, HookSendRefused, SendUncertainError } from "../errors";
import { nextGapMs, type Rng } from "../pace/jitter";
import { withCapabilities } from "../provider";
import type { Logger } from "../privacy/log";
import type {
	CapabilityMap,
	Conversation,
	DraftRecord,
	LinkResult,
	SmsMessage,
	SmsProvider,
	StatusResult,
} from "../types";
import type { MessagesBrowser } from "./browser";
import { normalizeRecipientName } from "./thread";

export const GOOGLE_CAPABILITIES: CapabilityMap = {
	link: true,
	status: true,
	listConversations: true,
	readRecent: true,
	receive: true,
	archive: true,
	blockAndReportSpam: true,
	draftReply: true,
	sendDraft: true,
	reactions: false,
	attachments: false,
	quotes: false,
};

const STATES = ["paired", "signed-out", "phone-unreachable", "unknown"] as const;

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object") throw new Error(label);
	return value as Record<string, unknown>;
}

function conversationsFrom(value: unknown): Conversation[] {
	const body = record(value, "page-unrecognized");
	if (!Array.isArray(body.conversations)) throw new Error("page-unrecognized");
	return body.conversations.map((item) => {
		const row = record(item, "page-unrecognized");
		if (typeof row.id !== "string" || row.id.length === 0) throw new Error("page-unrecognized");
		return {
			id: row.id,
			title: typeof row.sender === "string" ? row.sender : row.id,
			preview: typeof row.preview === "string" ? row.preview : "",
			pinned: row.pinned === true,
			savedContact: row.savedContact === true,
			ageDays: typeof row.ageDays === "number" ? row.ageDays : 0,
			kind: "dm" as const,
		};
	});
}

function messagesFrom(value: unknown, limit: number): SmsMessage[] {
	const body = record(value, "page-unrecognized");
	if (!Array.isArray(body.messages)) throw new Error("page-unrecognized");
	const messages = body.messages.map((item) => {
		const row = record(item, "page-unrecognized");
		if (typeof row.id !== "string") throw new Error("page-unrecognized");
		const contentType = typeof row.contentType === "string" ? row.contentType : "";
		return {
			id: row.id,
			conversationId: typeof row.conversationId === "string" ? row.conversationId : "",
			timestamp: typeof row.timestamp === "number" ? row.timestamp : 0,
			direction: "in" as const,
			senderId: typeof row.senderId === "string" ? row.senderId : "",
			text: typeof row.text === "string" ? row.text : undefined,
			attachments:
				contentType.startsWith("image/")
					? [{ id: row.id, contentType, byteLength: 0 }]
					: [],
		};
	});
	return messages
		.sort((a, b) => b.timestamp - a.timestamp)
		.slice(0, Math.max(0, limit));
}

function statusFrom(value: unknown): StatusResult {
	const body = record(value, "page-unrecognized");
	const state = body.state;
	if (!STATES.includes(state as (typeof STATES)[number])) throw new Error("page-unrecognized");
	const linked = state === "paired";
	return {
		linked,
		accountIds: linked ? ["google-messages"] : [],
		state: state as StatusResult["state"],
		reason: typeof body.reason === "string" ? body.reason : "page-unrecognized",
	};
}

export function createGoogleProvider(input: {
	browser: MessagesBrowser;
	home: string;
	config?: SmsCleanupConfig;
	log?: Logger;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	rng?: Rng;
	ids?: () => string;
}): SmsProvider {
	const config = input.config ?? defaultCleanupConfig();
	const log = input.log ?? (() => undefined);
	const now = input.now ?? (() => Date.now());
	const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
	const rng = input.rng ?? Math.random;
	const ids = input.ids ?? (() => crypto.randomUUID());
	const browser = input.browser;

	async function listedRows(): Promise<{ rows: Conversation[]; more: boolean }> {
		const body = record(await browser.act("rows", {}), "page-unrecognized");
		return {
			rows: conversationsFrom({ conversations: body.conversations }),
			more: body.more === true,
		};
	}

	async function loadConversationsForDraft(): Promise<{ rows: Conversation[]; complete: boolean }> {
		const gaps: number[] = [];
		let snap = await listedRows();
		let attempts = 0;
		while (snap.more && attempts < 6) {
			const before = snap.rows.length;
			await browser.act("load-more", {});
			let settled = false;
			for (let wait = 0; wait < 3; wait += 1) {
				const gap = nextGapMs(rng, gaps);
				gaps.push(gap);
				await sleep(gap);
				snap = await listedRows();
				if (!snap.more || snap.rows.length > before) {
					settled = true;
					break;
				}
			}
			if (!settled) return { rows: snap.rows, complete: false };
			attempts += 1;
		}
		if (snap.more) return { rows: snap.rows, complete: false };
		return { rows: snap.rows, complete: true };
	}

	return withCapabilities("google", GOOGLE_CAPABILITIES, {
		async link() {
			const status = statusFrom(await browser.act("status", {}));
			log({
				id: status.accountIds[0] ?? "google-messages",
				reason: status.linked ? "linked" : "not-linked",
				provider: "google",
				verb: "link",
			});
			const result: LinkResult = {
				linked: status.linked,
				accountId: status.accountIds[0] ?? "",
				state: status.state,
				reason: status.reason,
			};
			return result;
		},
		async status() {
			const status = statusFrom(await browser.act("status", {}));
			log({
				id: status.accountIds[0] ?? "google-messages",
				reason: status.linked ? "linked" : "not-linked",
				provider: "google",
				verb: "status",
			});
			return status;
		},
		async listConversations() {
			const days = scopeDays(config.scope);
			const rows = conversationsFrom(
				await browser.act("list", { scopeDays: days ?? null }),
			);
			log({ id: String(rows.length), reason: "list", provider: "google", verb: "list" });
			return rows;
		},
		async readRecent(conversationId, limit) {
			const messages = messagesFrom(
				await browser.act("read", { conversationId, limit }),
				limit,
			);
			log({ id: conversationId, reason: "read", provider: "google", verb: "read" });
			return messages;
		},
		async receive(request) {
			const found: SmsMessage[] = [];
			const waits: number[] = [];
			const deadline = now() + request.timeoutMs;
			while (found.length < request.limit) {
				const batch = messagesFrom(
					await browser.act("read", {
						conversationId: request.conversationId ?? "",
						limit: request.limit,
					}),
					request.limit,
				);
				for (const message of batch) {
					if (!found.some((item) => item.id === message.id)) found.push(message);
				}
				if (found.length >= request.limit || now() >= deadline) break;
				const gap = nextGapMs(rng, waits);
				waits.push(gap);
				await sleep(gap);
			}
			log({
				id: request.conversationId ?? String(found.length),
				reason: "receive",
				provider: "google",
				verb: "receive",
			});
			return found.slice(0, request.limit);
		},
		async archive(request) {
			const result = record(
				await browser.act("archive", { conversationId: request.conversationId }),
				"page-unrecognized",
			);
			if (result.reason !== "archived") throw new Error("archive failed");
			log({ id: request.conversationId, reason: "archive", provider: "google", verb: "archive" });
			return { conversationId: request.conversationId, reason: "archived" };
		},
		async blockAndReportSpam(request) {
			const result = record(
				await browser.act("block", { conversationId: request.conversationId }),
				"page-unrecognized",
			);
			if (result.reason !== "blocked") throw new Error("block failed");
			log({ id: request.conversationId, reason: "block", provider: "google", verb: "block" });
			return { conversationId: request.conversationId, reason: "blocked" };
		},
		async draftReply(request) {
			const loaded = await loadConversationsForDraft();
			const rows = loaded.rows;
			const row = rows.find((item) => item.id === request.conversationId);
			if (!row?.title) throw new Error("conversation not found");
			const name = normalizeRecipientName(row.title);
			const draft: DraftRecord = {
				id: ids(),
				provider: "google",
				conversationId: request.conversationId,
				recipient: row.title,
				ambiguousRecipient:
					!loaded.complete ||
					rows.filter((item) => normalizeRecipientName(item.title) === name).length > 1,
				text: request.text,
				emoji: request.emoji,
				remove: request.remove,
				targetTimestamp: request.targetTimestamp,
				targetAuthorId: request.targetAuthorId,
				attachments: request.attachments ?? [],
				quote: request.quote,
				createdAt: new Date(now()).toISOString(),
				status: "pending",
			};
			writeDraft(input.home, draft);
			log({ id: draft.id, reason: "draft", provider: "google", verb: "draft" });
			return draft;
		},
		async sendDraft(request) {
			if (request.hook) throw new HookSendRefused();
			if (!request.confirmed) throw new ConfirmationRequired();
			const lookedUp = readDraft(input.home, request.draftId);
			if (lookedUp.ambiguousRecipient !== false) throw new Error("ambiguous recipient");
			const draft = claimDraft(input.home, request.draftId, "google");
			try {
				if (draft.emoji || draft.quote || draft.attachments.length > 0) {
					throw new Error("google send supports plain text only");
				}
				if (!draft.recipient) throw new Error("conversation not found");
				const text = draft.text ?? "";
				const result = record(
					await browser.act("send", {
						confirmed: true,
						text,
						draftId: draft.id,
						conversationId: draft.conversationId,
						recipient: draft.recipient,
						ambiguous: draft.ambiguousRecipient === true,
					}),
					"page-unrecognized",
				);
				if (result.reason !== "sent") throw new SendUncertainError("send failed");
				if (result.conversationId !== draft.conversationId) {
					throw new SendUncertainError("open conversation does not match the draft");
				}
				finishDraft(input.home, draft, "sent");
				log({ id: draft.id, reason: "send", provider: "google", verb: "send" });
				return { draftId: draft.id, reason: "sent" as const };
			} catch (error) {
				if (error instanceof SendUncertainError) finishDraft(input.home, draft, "uncertain");
				else releaseDraft(input.home, draft);
				throw error;
			}
		},
	});
}
