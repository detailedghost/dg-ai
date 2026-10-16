import { isRecord } from "@dg/common";
import type { AdaptiveCard } from "../types";
import { discard, type RelayClient, statusError } from "./client";

const CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

async function send(
	client: RelayClient,
	label: string,
	body: Record<string, unknown>,
): Promise<{ messageIds: string[] }> {
	const response = await client.request("/message/teams", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.status !== 201) {
		await discard(response);
		throw statusError(label, response.status);
	}
	const payload: unknown = await response.json().catch(() => undefined);
	const ids = isRecord(payload) ? payload.messageIds : undefined;
	return {
		messageIds: Array.isArray(ids)
			? ids.filter((id): id is string => typeof id === "string")
			: [],
	};
}

export async function reply(
	client: RelayClient,
	ownerEmail: string,
	request: { chatId: string; text: string; html?: boolean; card?: AdaptiveCard },
): Promise<{ messageIds: string[] }> {
	if (request.chatId === "") throw new Error("reply needs a chat id");
	return await send(client, "reply", {
		To: [ownerEmail],
		Body: request.text,
		ChatId: request.chatId,
		Mode: "group",
		TextFormat: request.html ? "xml" : "plain",
		...(request.card && {
			AdaptiveCard: { ContentType: CARD_CONTENT_TYPE, Content: request.card },
		}),
	});
}

export function dm(
	client: RelayClient,
	ownerEmail: string,
	request: { text: string; html?: boolean },
): Promise<{ messageIds: string[] }> {
	return send(client, "dm", {
		To: [ownerEmail],
		Body: request.text,
		Mode: "direct",
		TextFormat: request.html ? "xml" : "plain",
	});
}
