import { hashId } from "../privacy/hash";
import {
	assertNoEmailAddress,
	fromDomain,
	redactText,
} from "../privacy/redact";
import type { MailFolder, MailMessageSummary } from "../providers/types";
import type { CodexPacket } from "./types";

export function packetForMessage(
	message: MailMessageSummary,
	folders: MailFolder[],
	snippetLength: number,
): CodexPacket {
	return packetForMessageWithFolderNames(
		message,
		folders.map((folder) => folder.name),
		snippetLength,
	);
}

/**
 * Hot-path variant that takes the already-computed folder-name list. `batch`
 * builds thousands of packets against the same folder set, so hoisting the
 * `folders.map(...)` out of the per-message loop avoids re-allocating that
 * array (and re-reading every folder name) once per message.
 */
export function packetForMessageWithFolderNames(
	message: MailMessageSummary,
	folderNames: string[],
	snippetLength: number,
): CodexPacket {
	const packet: CodexPacket = {
		kind: "message",
		id: hashId(message.id),
		sourceIdHash: hashId(message.id, "source_hash"),
		fromDomain:
			message.fromDomain && /^[a-z0-9.-]+$/i.test(message.fromDomain)
				? message.fromDomain.toLowerCase()
				: fromDomain(message.from),
		subject: redactText(message.subject, snippetLength),
		snippet: redactText(message.snippet, snippetLength),
		currentFolder: redactText(
			message.folderName ?? message.folderId,
			snippetLength,
		),
		categories: message.categories?.map((category) =>
			redactText(category, snippetLength),
		),
		folders: folderNames.map((name) => redactText(name, snippetLength)),
	};

	assertNoEmailAddress(JSON.stringify(packet));
	return packet;
}

export function packetsForMessages(
	messages: MailMessageSummary[],
	folders: MailFolder[],
	snippetLength: number,
): CodexPacket[] {
	return messages.map((message) =>
		packetForMessage(message, folders, snippetLength),
	);
}
