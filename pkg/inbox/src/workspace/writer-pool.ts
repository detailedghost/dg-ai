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
export function createWriterPool(
	size: number,
	config: WriterPoolConfig,
): WriterPool {
	const concurrency = Math.max(1, Math.min(32, Math.floor(size) || 1));
	return {
		process: async (messages) => {
			let failed = false;
			let failure: unknown;
			const entries = await pMap(
				messages,
				async (message) => {
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
