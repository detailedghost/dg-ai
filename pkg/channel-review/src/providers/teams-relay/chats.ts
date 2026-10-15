import { isRecord } from "@dg/common";
import { discard, type RelayClient, statusError } from "./client";

const CHAT_LIST_TIMEOUT_MS = 120_000;
const CHAT_CHECK_TIMEOUT_MS = 20_000;

export const notMemberRemedy = (botName: string): string =>
	`${botName} is not a member of this chat, or the chat id is wrong. Add ${botName} to the chat or fix chat.id.`;

type ChatSummary = { id: string; topic: string };

async function listChats(client: RelayClient): Promise<ChatSummary[]> {
	const response = await client.request("/chat/list", {
		signal: AbortSignal.timeout(CHAT_LIST_TIMEOUT_MS),
	});
	if (!response.ok) {
		await discard(response);
		throw statusError("chat list", response.status);
	}
	const body: unknown = await response.json().catch(() => {
		throw new Error("chat list response is not JSON");
	});
	if (!Array.isArray(body)) return [];
	return body.flatMap((item) =>
		isRecord(item) &&
		typeof item.id === "string" &&
		typeof item.topic === "string"
			? [{ id: item.id, topic: item.topic }]
			: [],
	);
}

async function checkEventsStream(
	client: RelayClient,
	chatId: string,
	botName: string,
): Promise<void> {
	const controller = new AbortController();
	const timeout = AbortSignal.timeout(CHAT_CHECK_TIMEOUT_MS);
	try {
		const response = await client.request(
			`/chat/${encodeURIComponent(chatId)}/events`,
			{
				headers: { Accept: "text/event-stream" },
				signal: AbortSignal.any([controller.signal, timeout]),
			},
		);
		controller.abort();
		await discard(response);
		if (response.status === 404) throw new Error(notMemberRemedy(botName));
		if (!response.ok)
			throw new Error(`events check failed with HTTP ${response.status}`);
	} catch (error) {
		if (timeout.aborted) {
			throw new Error(
				`chat check timed out after ${CHAT_CHECK_TIMEOUT_MS / 1000} s`,
			);
		}
		throw error;
	} finally {
		controller.abort();
	}
}

export async function resolveChat(
	client: RelayClient,
	query: { chatId?: string; topic?: string },
	botName: string,
): Promise<{ id: string; topic?: string }> {
	if (query.chatId) {
		await checkEventsStream(client, query.chatId, botName);
		return { id: query.chatId };
	}
	const wanted = query.topic?.trim().toLowerCase();
	if (!wanted) throw new Error("Pass a chat topic or --chat-id.");
	const matches = (await listChats(client)).filter(
		(chat) => chat.topic.trim().toLowerCase() === wanted,
	);
	const [match] = matches;
	if (match === undefined) {
		throw new Error(
			`Chat "${query.topic}" not found. Add ${botName} to the chat or pass --chat-id. The topic lookup sees only chats that the relay's service mailbox is in.`,
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`More than one chat is named "${query.topic}": ${matches.map((chat) => chat.id).join(", ")}. Pass --chat-id.`,
		);
	}
	return { id: match.id, topic: match.topic };
}
