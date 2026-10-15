import { isRecord } from "@dg/common";
import { discard, type RelayClient, retryAfterMs, statusError } from "./client";

const MIN_GAP_MS = 500;
const MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_MS = 1000;

type ReactionRequest = {
	chatId: string;
	messageId: string;
	reactionId: string;
};

export function createReactions({
	client,
	sleep,
	now,
}: {
	client: RelayClient;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
}) {
	let nextAt = 0;
	let tail: Promise<unknown> = Promise.resolve();

	const gated = <T>(task: () => Promise<T>): Promise<T> => {
		const run = tail.then(task);
		tail = run.catch(() => undefined);
		return run;
	};

	const send = (
		method: "PUT" | "DELETE",
		{ chatId, messageId, reactionId }: ReactionRequest,
	): Promise<void> =>
		gated(async () => {
			const path = `/message/teams/${encodeURIComponent(chatId)}/react/${encodeURIComponent(reactionId)}`;
			for (let attempt = 1; ; attempt += 1) {
				const wait = nextAt - now();
				if (wait > 0) await sleep(wait);
				nextAt = now() + MIN_GAP_MS;
				const response = await client.request(path, {
					method,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ messageId }),
				});
				await discard(response);
				if (response.ok || (method === "DELETE" && response.status === 404))
					return;
				if (response.status === 429 && attempt < MAX_ATTEMPTS) {
					await sleep(retryAfterMs(response) ?? DEFAULT_RETRY_MS);
					continue;
				}
				throw statusError("reaction request", response.status);
			}
		});

	return {
		react: (request: ReactionRequest) => send("PUT", request),
		unreact: (request: ReactionRequest) => send("DELETE", request),
		async list(): Promise<string[]> {
			const response = await client.request("/message/teams/react");
			if (!response.ok) {
				await discard(response);
				throw statusError("reaction list", response.status);
			}
			const body: unknown = await response.json().catch(() => {
				throw new Error("reaction list response is not JSON");
			});
			if (!Array.isArray(body)) return [];
			return body.flatMap((item) =>
				isRecord(item) && typeof item.id === "string" ? [item.id] : [],
			);
		},
	};
}
