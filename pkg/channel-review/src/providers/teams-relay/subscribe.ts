import { describeError, isRecord } from "@dg/common";
import type { Log } from "../../engine";
import type { ChatEvent, ChatSender } from "../types";
import {
	discard,
	RelayAuthError,
	type RelayClient,
	retryAfterMs,
} from "./client";
import type { Sleep } from "./sleep";
import { createSseParser, SseOverflowError, type SseFrame } from "./sse";

const IDLE_MS = 45_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;
const BACKOFF_JITTER = 0.2;
const DEFAULT_RATE_LIMIT_MS = 30_000;
const IDLE = Symbol("idle");

type SubscribeDeps = {
	client: RelayClient;
	sleep: Sleep;
	random: () => number;
	log: Log;
	botName: string;
};

function sender(value: unknown): ChatSender {
	const from = isRecord(value) ? value : {};
	return {
		id: typeof from.aadObjectId === "string" ? from.aadObjectId : undefined,
		name: typeof from.name === "string" ? from.name : undefined,
		isBot: from.isBot === true,
	};
}

function toChatEvent(frame: SseFrame, log: Log): ChatEvent | undefined {
	if (frame.event === "gap") return { type: "gap" };
	if (frame.event !== "message" && frame.event !== "reaction") return undefined;
	if (frame.data === "" || frame.data === "null") return undefined;
	let body: unknown;
	try {
		body = JSON.parse(frame.data);
	} catch {
		log.warn(`skipped a ${frame.event} event with unreadable data`);
		return undefined;
	}
	if (!isRecord(body) || typeof body.id !== "string") return undefined;
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";
	const eventId = frame.id ?? body.id;
	if (frame.event === "message") {
		return {
			type: "message",
			eventId,
			message: {
				id: body.id,
				chatId,
				from: sender(body.from),
				text: typeof body.text === "string" ? body.text : "",
				timestamp,
			},
		};
	}
	if (
		typeof body.messageId !== "string" ||
		typeof body.type !== "string" ||
		(body.action !== "added" && body.action !== "removed")
	) {
		return undefined;
	}
	return {
		type: "reaction",
		eventId,
		reaction: {
			id: body.id,
			chatId,
			messageId: body.messageId,
			from: sender(body.from),
			type: body.type,
			action: body.action,
			timestamp,
		},
	};
}

export function createSubscribe({ client, sleep, random, log, botName }: SubscribeDeps) {
	const jitter = (ms: number): number =>
		ms * (1 + (random() * 2 - 1) * BACKOFF_JITTER);

	async function sleepUnlessAborted(
		ms: number,
		signal: AbortSignal,
	): Promise<void> {
		const local = new AbortController();
		const stop = (): void => local.abort();
		signal.addEventListener("abort", stop, { once: true });
		const aborted = new Promise<void>((resolve) =>
			local.signal.addEventListener("abort", () => resolve(), { once: true }),
		);
		try {
			await Promise.race([sleep(ms, local.signal), aborted]);
		} finally {
			signal.removeEventListener("abort", stop);
			local.abort();
		}
	}

	async function* readEvents(
		body: ReadableStream<Uint8Array>,
		connection: AbortController,
	): AsyncGenerator<ChatEvent> {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		const parser = createSseParser();
		try {
			for (;;) {
				const idle = new AbortController();
				let next: Awaited<ReturnType<typeof reader.read>> | typeof IDLE;
				try {
					next = await Promise.race([
						reader.read(),
						sleep(IDLE_MS, idle.signal).then((): typeof IDLE => IDLE),
					]);
				} finally {
					idle.abort();
				}
				if (next === IDLE) {
					log.warn("no events or pings for 45 s; reconnecting");
					connection.abort();
					return;
				}
				if (next.done) return;
				for (const frame of parser.push(
					decoder.decode(next.value, { stream: true }),
				)) {
					const event = toChatEvent(frame, log);
					if (event) yield event;
				}
			}
		} catch (error) {
			if (error instanceof SseOverflowError) {
				log.warn(`${describeError(error)}; reconnecting`);
				connection.abort();
				return;
			}
			if (connection.signal.aborted) return;
			throw error;
		} finally {
			await reader.cancel().catch(() => undefined);
		}
	}

	return async function* subscribe({
		chatId,
		resumeId,
		signal,
	}: {
		chatId: string;
		resumeId?: string;
		signal: AbortSignal;
	}): AsyncGenerator<ChatEvent> {
		const path = `/chat/${encodeURIComponent(chatId)}/events`;
		let lastId = resumeId;
		let failures = 0;
		const backoff = (): number => {
			const delay = jitter(
				Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** failures),
			);
			failures += 1;
			return delay;
		};

		while (!signal.aborted) {
			const connection = new AbortController();
			const stop = (): void => connection.abort();
			signal.addEventListener("abort", stop, { once: true });
			let delay: number;
			try {
				const headers: Record<string, string> = { Accept: "text/event-stream" };
				if (lastId !== undefined) headers["Last-Event-ID"] = lastId;
				const response = await client.request(path, {
					headers,
					signal: connection.signal,
				});
				if (response.ok && response.body) {
					for await (const event of readEvents(response.body, connection)) {
						if (event.type !== "gap") lastId = event.eventId;
						if (event.type === "message") failures = 0;
						yield event;
					}
					delay = backoff();
				} else {
					await discard(response);
					if (response.status === 429) {
						delay = retryAfterMs(response) ?? DEFAULT_RATE_LIMIT_MS;
						log.warn(
							`events stream is rate limited; a stale earlier daemon connection is the usual cause; retrying in ${Math.round(delay / 1000)} s`,
						);
					} else if (response.status === 404) {
						delay = jitter(BACKOFF_CAP_MS);
						log.warn(`${botName} is not a member of this chat, or the chat id is wrong`);
					} else {
						log.warn(`events stream failed with HTTP ${response.status}`);
						delay = backoff();
					}
				}
			} catch (error) {
				if (error instanceof RelayAuthError) throw error;
				if (signal.aborted) return;
				log.warn(`events stream dropped: ${describeError(error)}`);
				delay = backoff();
			} finally {
				signal.removeEventListener("abort", stop);
				connection.abort();
			}
			if (signal.aborted) return;
			log.info(`events stream reconnecting in ${Math.round(delay)} ms`);
			await sleepUnlessAborted(delay, signal);
		}
	};
}
