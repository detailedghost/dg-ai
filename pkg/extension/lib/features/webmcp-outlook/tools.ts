import { redactText } from "@dg/common";
import type { WebMcpTool } from "../webmcp-shim";
import { type OwaItem, type OwaService, owaErrorCode, owaSucceeded } from "./service";

const MAX_IDS = 50;
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;
const BODY_MAX = 50_000;
const HTML_MAX = 20 * BODY_MAX;
const OUTPUT_MAX = 45_000;
const DISTINGUISHED_FOLDERS = ["inbox", "archive", "deleteditems", "junkemail", "drafts", "sentitems"];
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;

type Args = Record<string, unknown>;
type FolderRef = { __type: string; Id: string };
type Outcome = { ids: string[]; errors: Array<{ id: string; error: string }> };

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function codePoint(code: number): string {
	return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function dropHidden(html: string): string {
	const open = /<!--|<(head|script|style|title)\b/gi;
	let out = "";
	let from = 0;
	for (let match = open.exec(html); match; match = open.exec(html)) {
		out += html.slice(from, match.index);
		const close = match[1] ? new RegExp(`<\\/${match[1]}\\s*>`, "gi") : /-->/g;
		close.lastIndex = open.lastIndex;
		if (!close.exec(html)) return out;
		from = open.lastIndex = close.lastIndex;
	}
	return out + html.slice(from);
}

const TAG_START = /<[A-Za-z/!?]/g;

/** The index just past the > that ends the tag at open, skipping a > inside a quoted attribute; -1 when the tag never ends. */
function tagEnd(html: string, open: number): number {
	let quote = "";
	for (let at = open + 1; at < html.length; at += 1) {
		const char = html[at];
		if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") quote = char;
		else if (char === ">") return at + 1;
	}
	return -1;
}

function dropTags(html: string): string {
	let out = "";
	let from = 0;
	TAG_START.lastIndex = 0;
	for (let match = TAG_START.exec(html); match; match = TAG_START.exec(html)) {
		const end = tagEnd(html, match.index);
		if (end === -1) break;
		out += html.slice(from, match.index);
		from = TAG_START.lastIndex = end;
	}
	return out + html.slice(from);
}

/** Plain text of an OWA HTML body in linear time, built with string rules so it works under Trusted Types; capped at 50,000 characters. */
export function htmlToText(html: string): string {
	return dropTags(
		dropHidden(html.slice(0, HTML_MAX))
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table|ul|ol)\s*>/gi, "\n"),
	)
		.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name: string) => {
			if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? entity;
			return codePoint(name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1)));
		})
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, BODY_MAX);
}

/** Shortens the body until the serialized output, measured after the address mask, fits under the transport cap. */
function fitBody(build: (body: string, truncated: boolean) => string, body: string): string {
	let kept = body;
	let output = build(kept, false);
	for (let size = redactText(output).length; size > OUTPUT_MAX && kept.length > 0; size = redactText(output).length) {
		kept = kept.slice(0, Math.max(0, kept.length - (size - OUTPUT_MAX)));
		output = build(kept, true);
	}
	return output;
}

function escapeHtml(plain: string): string {
	return plain
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
		.replace(/\r?\n/g, "<br>");
}

function requireText(args: Args, name: string, { nonEmpty = false } = {}): string {
	const value = args[name];
	if (typeof value !== "string" || (nonEmpty && value.trim() === ""))
		throw new Error(nonEmpty ? `${name} must be a non-empty string.` : `${name} must be a string.`);
	return value;
}

function optionalFlag(args: Args, name: string, fallback: boolean): boolean {
	const value = args[name] ?? fallback;
	if (typeof value !== "boolean") throw new Error(`${name} must be true or false.`);
	return value;
}

function limitOf(args: Args): number {
	const value = args.limit ?? DEFAULT_LIMIT;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
		throw new Error(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
	return value;
}

function idsOf(args: Args): string[] {
	const value = args.ids;
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > MAX_IDS ||
		!value.every((id) => typeof id === "string" && id.trim() !== "")
	)
		throw new Error(`ids must hold 1 to ${MAX_IDS} item ids.`);
	return value as string[];
}

function addressesOf(args: Args): string[] {
	const value = args.to;
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > MAX_IDS ||
		!value.every((address) => typeof address === "string" && ADDRESS.test(address))
	)
		throw new Error(`to must hold 1 to ${MAX_IDS} addresses.`);
	return value as string[];
}

const itemIds = (ids: string[]) => ids.map((Id) => ({ __type: "ItemId:#Exchange", Id }));
const distinguished = (Id: string): FolderRef => ({ __type: "DistinguishedFolderId:#Exchange", Id });
const field = (FieldURI: string) => ({ __type: "PropertyUri:#Exchange", FieldURI });
const htmlBody = (plain: string) => ({ __type: "BodyContentType:#Exchange", BodyType: "HTML", Value: escapeHtml(plain) });

function message(item: OwaItem) {
	return {
		id: text(record(item.ItemId).Id),
		from: text(record(record(item.From).Mailbox).EmailAddress),
		date: text(item.DateTimeReceived),
		read: item.IsRead === true,
		flagged: record(item.Flag).FlagStatus === "Flagged",
	};
}

const page = (limit: number) => ({
	__type: "IndexedPageView:#Exchange",
	BasePoint: "Beginning",
	Offset: 0,
	MaxEntriesReturned: limit,
});
const subjectContains = (Value: string) => ({
	__type: "RestrictionType:#Exchange",
	Item: {
		__type: "Contains:#Exchange",
		Item: field("Subject"),
		Constant: { __type: "Constant:#Exchange", Value },
		ContainmentMode: "Substring",
		ContainmentComparison: "IgnoreCase",
	},
});
const newestFirst = (a: { date: string }, b: { date: string }) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);

const findItemsShape = {
	__type: "ItemResponseShape:#Exchange",
	BaseShape: "IdOnly",
	AdditionalProperties: ["From", "DateTimeReceived", "IsRead", "Flag"].map(field),
};

/** Splits the per-id response messages into the ids that succeeded and a code-only error per id that failed. */
function outcome(items: OwaItem[], ids: string[], idOf: (item: OwaItem, id: string) => string = (_item, id) => id): Outcome {
	const result: Outcome = { ids: [], errors: [] };
	ids.forEach((id, index) => {
		const item = items[index];
		if (item && owaSucceeded(item)) result.ids.push(idOf(item, id));
		else result.errors.push({ id, error: owaErrorCode(item) });
	});
	return result;
}

const newId = (item: OwaItem, id: string) => text(record(record(list(item.Items)[0]).ItemId).Id) || id;
const errorsOf = ({ errors }: Outcome) => (errors.length ? { errors } : {});

/** The ten Outlook mail tools; each returns one JSON string and echoes no recipient, subject or body it was given. */
export function createOutlookTools(service: OwaService): WebMcpTool[] {
	async function findItems(body: Record<string, unknown>, signal?: AbortSignal) {
		return service.call("FindItem", {
			__type: "FindItemRequest:#Exchange",
			ItemShape: findItemsShape,
			SortOrder: [{ __type: "SortResults:#Exchange", Order: "Descending", Path: field("DateTimeReceived") }],
			...body,
		}, signal);
	}

	const messagesOf = (response: OwaItem | undefined) =>
		list(record(record(response).RootFolder).Items).map((item) => message(record(item)));

	async function folderRef(name: string, signal?: AbortSignal): Promise<FolderRef> {
		const id = name.toLowerCase();
		if (DISTINGUISHED_FOLDERS.includes(id)) return distinguished(id);
		const [response] = await service.call("FindFolder", {
			__type: "FindFolderRequest:#Exchange",
			FolderShape: {
				__type: "FolderResponseShape:#Exchange",
				BaseShape: "Default",
			},
			ParentFolderIds: [distinguished("msgfolderroot")],
			Traversal: "Deep",
		}, signal);
		const found = list(record(record(response).RootFolder).Folders).filter((folder) => record(folder).DisplayName === name);
		if (found.length === 0) throw new Error("No mail folder has that name.");
		if (found.length > 1)
			throw new Error("Several mail folders have that name; move to a distinguished folder or rename one.");
		return { __type: "FolderId:#Exchange", Id: text(record(record(found[0]).FolderId).Id) };
	}

	async function moveItems(ids: string[], folder: FolderRef, signal?: AbortSignal): Promise<Outcome> {
		const items = await service.call("MoveItem", {
			__type: "MoveItemRequest:#Exchange",
			ToFolderId: { __type: "TargetFolderId:#Exchange", BaseFolderId: folder },
			ItemIds: itemIds(ids),
			ReturnNewItemIds: true,
		}, signal);
		return outcome(items, ids, newId);
	}

	async function updateItems(
		ids: string[],
		FieldURI: string,
		Item: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<string> {
		const items = await service.call("UpdateItem", {
			__type: "UpdateItemRequest:#Exchange",
			ConflictResolution: "AlwaysOverwrite",
			MessageDisposition: "SaveOnly",
			SuppressReadReceipts: true,
			ItemChanges: ids.map((Id) => ({
				__type: "ItemChange:#Exchange",
				ItemId: { __type: "ItemId:#Exchange", Id },
				Updates: [{ __type: "SetItemField:#Exchange", Path: field(FieldURI), Item: { __type: "Message:#Exchange", ...Item } }],
			})),
		}, signal);
		const result = outcome(items, ids);
		return JSON.stringify({ updated: result.ids.length, ids: result.ids, ...errorsOf(result) });
	}

	const idsSchema = {
		type: "array",
		items: { type: "string", minLength: 1 },
		minItems: 1,
		maxItems: MAX_IDS,
		description: `OWA item ids, at most ${MAX_IDS}.`,
	};
	const limitSchema = {
		type: "integer",
		minimum: 1,
		maximum: MAX_LIMIT,
		default: DEFAULT_LIMIT,
		description: `How many messages to return, 1 to ${MAX_LIMIT}.`,
	};
	const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
		type: "object",
		properties,
		...(required.length ? { required } : {}),
		additionalProperties: false,
	});

	return [
		{
			name: "dg_outlook_list",
			description:
				"List the newest messages in a mail folder: id, sender address, date, read and flagged. Subject and preview are masked; read one message with dg_outlook_read.",
			inputSchema: schema({
				folder: {
					type: "string",
					default: "inbox",
					description: `A distinguished folder (${DISTINGUISHED_FOLDERS.join(", ")}) or the exact name of a custom folder.`,
				},
				limit: limitSchema,
			}),
			async execute(args, { signal } = {}) {
				const limit = limitOf(args);
				const folder = await folderRef(
					args.folder === undefined ? "inbox" : requireText(args, "folder", { nonEmpty: true }),
					signal,
				);
				const [response] = await findItems({ ParentFolderIds: [folder], Traversal: "Shallow", Paging: page(limit) }, signal);
				return JSON.stringify({ messages: messagesOf(response) });
			},
		},
		{
			name: "dg_outlook_search",
			description: `Find the messages whose subject holds the query text, ignoring case, in the ${DISTINGUISHED_FOLDERS.join(", ")} folders, newest first, with the fields of dg_outlook_list. Subject and preview are masked.`,
			inputSchema: schema(
				{
					query: { type: "string", minLength: 1, description: "Text to find in the subject, ignoring case." },
					limit: limitSchema,
				},
				["query"],
			),
			async execute(args, { signal } = {}) {
				const query = requireText(args, "query", { nonEmpty: true });
				const limit = limitOf(args);
				const responses = await findItems({
					ParentFolderIds: DISTINGUISHED_FOLDERS.map(distinguished),
					Traversal: "Shallow",
					Restriction: subjectContains(query),
					Paging: page(limit),
				}, signal);
				const errors = DISTINGUISHED_FOLDERS.flatMap((folder, index) =>
					owaSucceeded(responses[index]) ? [] : [{ folder, error: owaErrorCode(responses[index]) }],
				);
				const messages = responses.filter(owaSucceeded).flatMap(messagesOf).sort(newestFirst).slice(0, limit);
				return JSON.stringify({ messages, ...(errors.length ? { errors } : {}) });
			},
		},
		{
			name: "dg_outlook_read",
			description:
				"Read one message as plain text without changing its read state. The body is capped at 50,000 characters, and shortened further with truncated set to true when the whole answer would not fit the output limit.",
			inputSchema: schema({ id: { type: "string", minLength: 1, description: "The OWA item id." } }, ["id"]),
			async execute(args, { signal } = {}) {
				const id = requireText(args, "id", { nonEmpty: true });
				const [response] = await service.call("GetItem", {
					__type: "GetItemRequest:#Exchange",
					ItemShape: {
						__type: "ItemResponseShape:#Exchange",
						BaseShape: "IdOnly",
						BodyType: "HTML",
						AdditionalProperties: ["Subject", "From", "ToRecipients", "DateTimeReceived", "Body"].map(field),
					},
					ItemIds: itemIds([id]),
				}, signal);
				const item = record(list(record(response).Items)[0]);
				const body = record(item.Body);
				const fields = {
					id: text(record(item.ItemId).Id) || id,
					subject: text(item.Subject),
					from: text(record(record(item.From).Mailbox).EmailAddress),
					to: list(item.ToRecipients).map((recipient) => text(record(recipient).EmailAddress)),
					date: text(item.DateTimeReceived),
				};
				return fitBody(
					(kept, truncated) => JSON.stringify({ ...fields, body: kept, ...(truncated ? { truncated } : {}) }),
					body.BodyType === "Text" ? text(body.Value).slice(0, BODY_MAX) : htmlToText(text(body.Value)),
				);
			},
		},
		{
			name: "dg_outlook_mark_read",
			description: "Mark messages read, or unread with read set to false.",
			inputSchema: schema({ ids: idsSchema, read: { type: "boolean", default: true } }, ["ids"]),
			async execute(args, { signal } = {}) {
				const ids = idsOf(args);
				return updateItems(ids, "IsRead", { IsRead: optionalFlag(args, "read", true) }, signal);
			},
		},
		{
			name: "dg_outlook_flag",
			description: "Flag messages, or clear the flag with flagged set to false.",
			inputSchema: schema({ ids: idsSchema, flagged: { type: "boolean", default: true } }, ["ids"]),
			async execute(args, { signal } = {}) {
				const ids = idsOf(args);
				const FlagStatus = optionalFlag(args, "flagged", true) ? "Flagged" : "NotFlagged";
				return updateItems(ids, "Flag", { Flag: { __type: "FlagType:#Exchange", FlagStatus } }, signal);
			},
		},
		{
			name: "dg_outlook_move",
			description: "Move messages to a distinguished folder or to a custom folder with that exact name; returns the new ids.",
			inputSchema: schema(
				{
					ids: idsSchema,
					folder: {
						type: "string",
						minLength: 1,
						description: `A distinguished folder (${DISTINGUISHED_FOLDERS.join(", ")}) or the exact name of a custom folder.`,
					},
				},
				["ids", "folder"],
			),
			async execute(args, { signal } = {}) {
				const ids = idsOf(args);
				const folder = requireText(args, "folder", { nonEmpty: true });
				const moved = await moveItems(ids, await folderRef(folder, signal), signal);
				return JSON.stringify({ moved: moved.ids.length, ids: moved.ids, folder, ...errorsOf(moved) });
			},
		},
		{
			name: "dg_outlook_archive",
			description: "Move messages to the Archive folder; returns the new ids.",
			inputSchema: schema({ ids: idsSchema }, ["ids"]),
			async execute(args, { signal } = {}) {
				const archived = await moveItems(idsOf(args), distinguished("archive"), signal);
				return JSON.stringify({ archived: archived.ids.length, ids: archived.ids, ...errorsOf(archived) });
			},
		},
		{
			name: "dg_outlook_delete",
			description: "Move messages to Deleted Items. This tool never deletes permanently.",
			inputSchema: schema({ ids: idsSchema }, ["ids"]),
			async execute(args, { signal } = {}) {
				const ids = idsOf(args);
				const items = await service.call("DeleteItem", {
					__type: "DeleteItemRequest:#Exchange",
					DeleteType: "MoveToDeletedItems",
					SendMeetingCancellations: "SendToNone",
					AffectedTaskOccurrences: "AllOccurrences",
					ItemIds: itemIds(ids),
				}, signal);
				const deleted = outcome(items, ids);
				return JSON.stringify({ deleted: deleted.ids.length, ids: deleted.ids, ...errorsOf(deleted) });
			},
		},
		{
			name: "dg_outlook_draft",
			description: "Save a new draft in Drafts without sending it. The body is plain text.",
			inputSchema: schema(
				{
					to: {
						type: "array",
						items: { type: "string" },
						minItems: 1,
						maxItems: MAX_IDS,
						description: "Recipient email addresses.",
					},
					subject: { type: "string" },
					body: { type: "string", description: "Plain text; markup is sent as text." },
				},
				["to", "subject", "body"],
			),
			async execute(args, { signal } = {}) {
				const to = addressesOf(args);
				const Subject = requireText(args, "subject");
				const body = requireText(args, "body");
				const [response] = await service.call("CreateItem", {
					__type: "CreateItemRequest:#Exchange",
					MessageDisposition: "SaveOnly",
					SavedItemFolderId: { __type: "TargetFolderId:#Exchange", BaseFolderId: distinguished("drafts") },
					Items: [
						{
							__type: "Message:#Exchange",
							Subject,
							Body: htmlBody(body),
							ToRecipients: to.map((EmailAddress) => ({ __type: "EmailAddress:#Exchange", EmailAddress })),
						},
					],
				}, signal);
				return JSON.stringify({ id: text(record(record(list(record(response).Items)[0]).ItemId).Id) });
			},
		},
		{
			name: "dg_outlook_reply",
			description: "Send a reply, or a reply to all with replyAll, to one message. This sends mail. The body is plain text.",
			inputSchema: schema(
				{
					id: { type: "string", minLength: 1, description: "The OWA item id of the message to answer." },
					body: { type: "string", description: "Plain text; markup is sent as text." },
					replyAll: { type: "boolean", default: false },
				},
				["id", "body"],
			),
			async execute(args, { signal } = {}) {
				const id = requireText(args, "id", { nonEmpty: true });
				const body = requireText(args, "body");
				const replyAll = optionalFlag(args, "replyAll", false);
				await service.call("CreateItem", {
					__type: "CreateItemRequest:#Exchange",
					MessageDisposition: "SendAndSaveCopy",
					Items: [
						{
							__type: replyAll ? "ReplyAllToItem:#Exchange" : "ReplyToItem:#Exchange",
							ReferenceItemId: { __type: "ItemId:#Exchange", Id: id },
							NewBodyContent: htmlBody(body),
						},
					],
				}, signal);
				return JSON.stringify({ sent: true, id });
			},
		},
	];
}
