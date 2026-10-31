import { createHash } from "node:crypto";
import type { SmsMessage } from "../types";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function accountIdFrom(value: unknown): string | undefined {
	const row = asRecord(value);
	if (!row) return undefined;
	return text(row.aci) ?? text(row.uuid) ?? text(row.accountId);
}

export function stripAccountNumber<T extends Record<string, unknown>>(row: T): T {
	const copy = { ...row };
	delete copy.number;
	delete copy.sourceNumber;
	delete copy.source;
	return copy;
}

function senderId(envelope: Record<string, unknown>): string {
	const uuid = text(envelope.sourceUuid) ?? text(envelope.sourceAci);
	if (uuid) return uuid;
	const number = text(envelope.sourceNumber) ?? text(envelope.source);
	if (!number) return "unknown";
	return `phone:${createHash("sha256").update(number).digest("hex").slice(0, 12)}`;
}

function conversationId(data: Record<string, unknown> | undefined, sender: string): string {
	const group = asRecord(data?.groupInfo) ?? asRecord(data?.groupV2);
	const groupId = text(group?.groupId) ?? text(group?.id);
	return groupId ?? sender;
}

export function messageFromEnvelope(value: unknown): SmsMessage | undefined {
	const wrapper = asRecord(value);
	if (!wrapper) return undefined;
	const envelope = asRecord(wrapper.envelope) ?? wrapper;
	const data = asRecord(envelope.dataMessage);
	const sync = asRecord(envelope.syncMessage);
	const sent = asRecord(sync?.sentMessage);
	const body = data ?? sent;
	if (!body) return undefined;
	const sender = senderId(envelope);
	const timestamp = num(body.timestamp) ?? num(envelope.timestamp) ?? 0;
	const reaction = asRecord(body.reaction);
	const quote = asRecord(body.quote);
	const attachments = Array.isArray(body.attachments) ? body.attachments : [];
	const id = text(envelope.id) ?? `${conversationId(body, sender)}:${timestamp}`;
	return {
		id,
		conversationId: conversationId(body, sender),
		timestamp,
		direction: sent ? "out" : "in",
		senderId: sender,
		text: text(body.message),
		reaction: reaction
			? {
					emoji: text(reaction.emoji) ?? "",
					targetTimestamp: num(reaction.targetSentTimestamp) ?? num(reaction.targetTimestamp) ?? 0,
					targetAuthorId:
						text(reaction.targetAuthorUuid) ??
						text(reaction.targetAuthorAci) ??
						"unknown",
					remove: reaction.isRemove === true || reaction.remove === true,
				}
			: undefined,
		attachments: attachments.flatMap((item) => {
			const row = asRecord(item);
			if (!row) return [];
			const contentType = text(row.contentType) ?? "application/octet-stream";
			return [
				{
					id: text(row.id) ?? `${id}:${contentType}`,
					contentType,
					byteLength: num(row.size) ?? num(row.byteLength) ?? 0,
					path: text(row.path),
				},
			];
		}),
		quote: quote
			? {
					authorId: text(quote.authorUuid) ?? text(quote.authorAci) ?? text(quote.author) ?? "unknown",
					timestamp: num(quote.id) ?? num(quote.timestamp) ?? 0,
					text: text(quote.text),
				}
			: undefined,
	};
}

export function envelopesFrom(value: unknown): SmsMessage[] {
	if (Array.isArray(value)) {
		return value.flatMap((item) => {
			const message = messageFromEnvelope(item);
			return message ? [message] : [];
		});
	}
	const row = asRecord(value);
	if (!row) return [];
	if (Array.isArray(row.results)) return envelopesFrom(row.results);
	const one = messageFromEnvelope(row);
	return one ? [one] : [];
}
