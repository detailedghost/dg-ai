import { readFileSync } from "node:fs";
import { isRecord } from "@dg/common";
import { type PlatformSeam, platformAlive } from "./platform";
import type { ChatRef } from "./shared";

const DAEMON_ARGS = /\bchannel-review\s+run\b/;

export type PidRecord = {
	pid: number;
	startedAt?: string;
	chats?: ChatRef[];
};

export function readPidRecord(path: string): PidRecord | undefined {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(raw)) return undefined;
		const { pid, startedAt, chats, chatId, chatTopic } = raw;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			return undefined;
		}
		const text = (value: unknown) =>
			typeof value === "string" ? value : undefined;
		const refs = Array.isArray(chats)
			? chats.flatMap((chat) =>
					isRecord(chat) && typeof chat.id === "string"
						? [{ id: chat.id, topic: text(chat.topic) }]
						: [],
				)
			: typeof chatId === "string"
				? [{ id: chatId, topic: text(chatTopic) }]
				: undefined;
		return { pid, startedAt: text(startedAt), chats: refs };
	} catch {
		return undefined;
	}
}

export async function isOurDaemon(
	pid: number,
	platform: PlatformSeam,
): Promise<boolean> {
	if (!platformAlive(pid, platform)) return false;
	return DAEMON_ARGS.test(await platform.listArgs(pid));
}
