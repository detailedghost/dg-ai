import pMap from "p-map";
import { join } from "node:path";
import { transformMessage } from "./message-transform";
import type { MailMessageSummary } from "../providers/types";
import type { MessageStatusEntry } from "./types";
export type WriterPoolConfig = {
	folderNames: string[];
	snippetLength: number;
	nowIso: string;
	messagesDirAbs: string;
};
export interface WriterPool {
	process(messages: MailMessageSummary[]): Promise<MessageStatusEntry[]>;
	close(): Promise<void>;
}
export function normalizeWriterCount(size: number): number {
	return Math.max(1, Math.min(32, Math.floor(size) || 1));
}

export function createWriterPool(
	size: number,
	config: WriterPoolConfig,
): WriterPool {
	const concurrency = normalizeWriterCount(size);
	let active = 0;
	const waiting: Array<() => void> = [];
	const acquire = async () => {
		if (active < concurrency) active++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
	};
	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else active--;
	};
	return {
		process: async (messages) => {
			let failed = false;
			let failure: unknown;
			const entries = await pMap(
				messages,
				async (message) => {
					await acquire();
					try {
						const transformed = transformMessage(
							message,
							config.folderNames,
							config.snippetLength,
							config.nowIso,
						);
						await Bun.write(
							join(config.messagesDirAbs, transformed.id + ".json"),
							transformed.json,
						);
						return transformed.entry;
					} catch (error) {
						if (!failed) {
							failed = true;
							failure = error;
						}
						return null;
					} finally {
						release();
					}
				},
				{ concurrency },
			);
			if (failed) throw failure;
			return entries.filter(
				(entry): entry is MessageStatusEntry => entry !== null,
			);
		},
		close: async () => {},
	};
}
