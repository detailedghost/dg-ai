import { packetForMessageWithFolderNames } from "../classifier/packets";
import { stringifyJson } from "../utils/json";
import type { MailMessageSummary } from "../providers/types";
import type { MessageStatusEntry, MessageWorkItem } from "./types";

export type TransformedMessage = {
	id: string;
	json: string;
	entry: MessageStatusEntry;
};

/** Builds and serializes a redacted work item; the caller owns its asynchronous file write. */
export function transformMessage(
	message: MailMessageSummary,
	folderNames: string[],
	snippetLength: number,
	nowIso: string,
): TransformedMessage {
	const packet = packetForMessageWithFolderNames(
		message,
		folderNames,
		snippetLength,
	);
	const currentFolder = message.folderName ?? message.folderId;
	const item: MessageWorkItem = {
		kind: "message-work-item",
		id: packet.id,
		sourceMessageId: message.id,
		sourceIdHash: packet.sourceIdHash,
		file: `messages/${packet.id}.json`,
		status: "fetched",
		statusUpdatedAt: nowIso,
		receivedAt: message.receivedAt,
		currentFolder,
		packet,
	};
	return {
		id: packet.id,
		json: stringifyJson(item),
		entry: {
			id: item.id,
			file: item.file,
			status: item.status,
			statusUpdatedAt: item.statusUpdatedAt,
			currentFolder: item.currentFolder,
			fromDomain: packet.fromDomain,
			subject: packet.subject,
		},
	};
}
