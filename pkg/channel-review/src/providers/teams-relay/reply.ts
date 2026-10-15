import { isRecord } from "@dg/common";
import type { AdaptiveCard } from "../types";
import { discard, type RelayClient, statusError } from "./client";

const CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

export async function reply(
	client: RelayClient,
	ownerEmail: string,
	request: { chatId: string; text: string; html?: boolean; card?: AdaptiveCard },
): Promise<{ messageIds: string[] }> {
	if (request.chatId === "") throw new Error("reply needs a chat id");
	const response = await client.request("/message/teams", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			To: [ownerEmail],
			Body: request.text,
			ChatId: request.chatId,
			Mode: "group",
			TextFormat: request.html ? "xml" : "plain",
			...(request.card && {
				AdaptiveCard: { ContentType: CARD_CONTENT_TYPE, Content: request.card },
			}),
		}),
	});
	if (response.status !== 201) {
		await discard(response);
		throw statusError("reply", response.status);
	}
	const body: unknown = await response.json().catch(() => undefined);
	const ids = isRecord(body) ? body.messageIds : undefined;
	return {
		messageIds: Array.isArray(ids)
			? ids.filter((id): id is string => typeof id === "string")
			: [],
	};
}
