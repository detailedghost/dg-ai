import { hashId } from "./hash";
import { fromDomain, redactText } from "./redact";
import type {
	MailFolder,
	MailMessageSummary,
	MailRule,
} from "../providers/types";

export function redactInventoryRow(
	row: MailFolder | MailRule | MailMessageSummary,
	snippetLength: number,
): Record<string, unknown> {
	if ("from" in row) {
		return {
			id: hashId(row.id),
			sourceIdHash: hashId(row.id, "source_hash"),
			fromDomain:
				row.fromDomain && /^[a-z0-9.-]+$/i.test(row.fromDomain)
					? row.fromDomain.toLowerCase()
					: fromDomain(row.from),
			subject: redactText(row.subject, snippetLength),
			snippet: redactText(row.snippet, snippetLength),
			folderId: row.folderId,
			folderName: row.folderName
				? redactText(row.folderName, snippetLength)
				: undefined,
			receivedAt: row.receivedAt,
			categories: row.categories?.map((category) =>
				redactText(category, snippetLength),
			),
			isRead: row.isRead,
		};
	}

	if ("conditions" in row) {
		return {
			id: row.id,
			name: redactText(row.name, snippetLength),
			enabled: row.enabled,
			conditions: row.conditions.map((condition) =>
				redactText(condition, snippetLength),
			),
			actions: row.actions.map((action) => redactText(action, snippetLength)),
		};
	}

	return {
		...row,
		name: redactText(row.name, snippetLength),
		path: row.path ? redactText(row.path, snippetLength) : undefined,
	};
}
