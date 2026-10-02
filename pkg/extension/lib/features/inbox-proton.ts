import {
	validateInboxBrowserRequest,
	validateInboxBrowserResponse,
	type InboxBrowserRequest,
	type InboxBrowserResponse,
	type InboxFilter,
	type InboxFolder,
	type InboxMessage,
} from "@dg/common";
import {
	isProtonMailOrigin,
	type ProtonSessionHeaders,
} from "./inbox-proton-observer";

type RecordValue = Record<string, unknown>;
class ProtonOperationError extends Error {}
type ProtonPageContext = {
	origin: string;
	headers?: ProtonSessionHeaders;
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	timeoutMs?: number;
};
const malformed = () =>
	new Error(
		"Proton API returned an unsupported response. Reload Proton Mail and retry.",
	);
function record(value: unknown): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw malformed();
	return value as RecordValue;
}
function str(...values: unknown[]): string {
	return (
		values.find((value): value is string => typeof value === "string") ?? ""
	);
}
function optionalStr(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}
function count(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && Number(value) >= 0
		? Number(value)
		: undefined;
}
function items(response: RecordValue, key: string): RecordValue[] {
	if (!Array.isArray(response[key])) throw malformed();
	return response[key].map(record);
}

export function redactInboxText(text: string, limit = 1000): string {
	return text
		.replace(
			/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi,
			"[email:$1]",
		)
		.replace(/(?:\+?\d[\d ()-]{6,}\d)/g, "[number]")
		.replace(/\b\d{8,}\b/g, "[number]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);
}
function normalizeFolder(raw: RecordValue): InboxFolder {
	const id = str(raw.ID);
	const name = str(raw.Name);
	if (!id || !name) throw malformed();
	return {
		id,
		name,
		type:
			raw.Type === 3 || raw.Exclusive === 1 || raw.Exclusive === true
				? "folder"
				: raw.Type === 4
					? "system"
					: "label",
		...(optionalStr(raw.Path) ? { path: str(raw.Path) } : {}),
		...(optionalStr(raw.ParentID) ? { parentId: str(raw.ParentID) } : {}),
		...(count(raw.Total) !== undefined ? { total: count(raw.Total) } : {}),
		...(count(raw.Unread) !== undefined ? { unread: count(raw.Unread) } : {}),
	};
}
function normalizeFilter(raw: RecordValue): InboxFilter {
	const id = str(raw.ID);
	if (!id) throw malformed();
	const sieve = str(raw.Sieve);
	const strings = (value: unknown) =>
		Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === "string")
			: [];
	return {
		id,
		name: str(raw.Name) || id,
		enabled: raw.Status === 1,
		conditions: sieve ? [sieve] : strings(raw.Conditions),
		actions: sieve ? [sieve] : strings(raw.Actions),
		...(count(raw.Order ?? raw.Sequence) !== undefined
			? { sequence: count(raw.Order ?? raw.Sequence) }
			: {}),
	};
}
function normalizeMessage(
	raw: RecordValue,
	requestedFolder?: string,
): InboxMessage {
	const sender =
		raw.Sender && typeof raw.Sender === "object" ? record(raw.Sender) : {};
	const from = str(sender.Address, raw.SenderAddress);
	const fromDomain = /@([^\s>]+)$/.exec(from)?.[1]?.toLowerCase();
	const labels = Array.isArray(raw.LabelIDs)
		? raw.LabelIDs.filter((entry): entry is string => typeof entry === "string")
		: [];
	const id = str(raw.ID);
	if (!id) throw malformed();
	const time =
		typeof raw.Time === "number" && Number.isFinite(raw.Time)
			? new Date(raw.Time * 1000)
			: undefined;
	return {
		id,
		from: redactInboxText(from, 2048),
		...(fromDomain ? { fromDomain } : {}),
		...(str(sender.Name)
			? { senderName: redactInboxText(str(sender.Name)) }
			: {}),
		subject: redactInboxText(str(raw.Subject), 2048),
		snippet: redactInboxText(str(raw.Context, raw.Snippet, raw.Summary), 4096),
		folderId: requestedFolder ?? (str(raw.LabelID, labels[0]) || "0"),
		labels,
		...(raw.Unread === 0 || raw.Unread === 1 ? { read: raw.Unread === 0 } : {}),
		...(time && !Number.isNaN(time.getTime())
			? { receivedAt: time.toISOString() }
			: {}),
	};
}

export function sanitizeInboxBrowserResponse(
	value: unknown,
): InboxBrowserResponse {
	const response = validateInboxBrowserResponse(value);
	return validateInboxBrowserResponse({
		...response,
		...(response.messages
			? {
					messages: response.messages.map((message) => ({
						...message,
						from: redactInboxText(message.from, 2048),
						subject: redactInboxText(message.subject, 2048),
						snippet: redactInboxText(message.snippet, 4096),
						...(message.senderName
							? { senderName: redactInboxText(message.senderName) }
							: {}),
					})),
				}
			: {}),
	});
}

async function boundedJson(response: Response): Promise<RecordValue> {
	if (!response.body) throw malformed();
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let json = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > 4_194_304) {
				await reader.cancel();
				throw malformed();
			}
			json += decoder.decode(value, { stream: true });
		}
		return record(JSON.parse(json + decoder.decode()));
	} finally {
		reader.releaseLock();
	}
}

export async function executeProtonPage(
	input: InboxBrowserRequest,
	context: ProtonPageContext,
): Promise<InboxBrowserResponse> {
	const request = validateInboxBrowserRequest(input);
	if (!isProtonMailOrigin(context.origin))
		throw new ProtonOperationError(
			"Open an authenticated HTTPS Proton Mail origin to use inbox cleanup.",
		);
	if (request.operation === "create-filter" && !request.sieve?.trim())
		throw new ProtonOperationError(
			"Proton filter creation requires a reviewed non-empty Sieve policy.",
		);
	if (!context.headers?.uid)
		throw new ProtonOperationError(
			"Sign in to Proton Mail, reload the mail tab, then retry so the extension observes its session.",
		);
	const controller = new AbortController();
	const timeoutMs = Math.min(Math.max(context.timeoutMs ?? 25_000, 1), 120_000);
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	async function api(
		path: string,
		method = "GET",
		body?: unknown,
	): Promise<RecordValue> {
		const headers = context.headers!;
		try {
			const response = await context.fetch(`${context.origin}/api/${path}`, {
				method,
				credentials: "include",
				mode: "same-origin",
				redirect: "error",
				signal: controller.signal,
				headers: {
					accept: "application/vnd.protonmail.v1+json",
					"x-pm-uid": headers.uid,
					...(headers.appVersion
						? { "x-pm-appversion": headers.appVersion }
						: {}),
					...(headers.locale ? { "x-pm-locale": headers.locale } : {}),
					...(body !== undefined ? { "content-type": "application/json" } : {}),
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
			if (response.status === 401 || response.status === 403)
				throw new ProtonOperationError(
					"Sign in to Proton Mail and reload its tab to restore the authenticated session.",
				);
			if (!response.ok)
				throw new ProtonOperationError(
					"Proton API request failed. Check the mail tab and retry after any rate limit clears.",
				);
			const json = await boundedJson(response);
			if (
				(method !== "GET" || json.Code !== undefined) &&
				json.Code !== 1000 &&
				json.Code !== 1001
			)
				throw new ProtonOperationError(
					"Proton API rejected the operation. Check the mail tab and reviewed settings before retrying.",
				);
			if (json.Code === 1001 || json.Responses !== undefined) {
				const responses = items(json, "Responses");
				const expected =
					body &&
					typeof body === "object" &&
					"IDs" in body &&
					Array.isArray(body.IDs)
						? body.IDs
						: [];
				const actual = new Set(responses.map((entry) => str(entry.ID)));
				if (
					!expected.length ||
					responses.length !== expected.length ||
					expected.some((id) => !actual.has(id)) ||
					responses.some((entry) => record(entry.Response).Code !== 1000)
				) {
					throw new ProtonOperationError(
						"Proton API did not complete every reviewed message action. Refresh the mailbox state before retrying.",
					);
				}
			}
			return json;
		} catch (error) {
			if (controller.signal.aborted)
				throw new ProtonOperationError(
					"Proton request timed out. Check the mail tab and retry.",
				);
			if (error instanceof ProtonOperationError) throw error;
			throw new ProtonOperationError(
				"Proton API could not complete the operation. Reload its mail tab and retry.",
			);
		}
	}
	try {
		let result: InboxBrowserResponse;
		switch (request.operation) {
			case "list-folders": {
				const [labels, folders, counts] = await Promise.all([
					api("core/v4/labels?Type=1"),
					api("core/v4/labels?Type=3"),
					api("mail/v4/messages/count"),
				]);
				const system: InboxFolder[] = [
					["0", "Inbox"],
					["3", "Trash"],
					["4", "Spam"],
					["5", "All Mail"],
					["6", "Archive"],
					["7", "Sent"],
					["8", "Drafts"],
					["10", "Starred"],
				].map(([id, name]) => ({ id: id!, name: name!, type: "system" }));
				const merged = new Map(
					[
						...system,
						...items(labels, "Labels").map(normalizeFolder),
						...items(folders, "Labels").map(normalizeFolder),
					].map((folder) => [folder.id, folder]),
				);
				if (Array.isArray(counts.Counts))
					for (const raw of counts.Counts.map(record)) {
						const folder = merged.get(str(raw.LabelID));
						if (folder) {
							folder.total = count(raw.Total);
							folder.unread = count(raw.Unread);
						}
					}
				function path(
					folder: InboxFolder,
					visited = new Set<string>(),
				): string {
					if (visited.has(folder.id)) throw malformed();
					visited.add(folder.id);
					const parent = folder.parentId
						? merged.get(folder.parentId)
						: undefined;
					return (
						folder.path ??
						(parent ? `${path(parent, visited)}/${folder.name}` : folder.name)
					);
				}
				result = {
					folders: [...merged.values()].map((folder) => ({
						...folder,
						path: path(folder),
					})),
				};
				break;
			}
			case "list-filters":
				result = {
					filters: items(await api("mail/v4/filters"), "Filters").map(
						normalizeFilter,
					),
				};
				break;
			case "list-messages": {
				const size = request.pageSize ?? 50;
				const page = request.page ?? 0;
				const params = new URLSearchParams({
					Page: String(page),
					PageSize: String(size),
					Limit: String(size),
				});
				if (request.folderId) params.set("LabelID[]", request.folderId);
				const json = await api(`mail/v4/messages?${params}`);
				if (json.Stale === true || json.Stale === 1)
					throw new ProtonOperationError(
						"Proton message page is stale. Refresh the mail tab and retry the scan.",
					);
				const messages = items(json, "Messages");
				if (messages.length > size) throw malformed();
				result = {
					messages: messages.map((message) =>
						normalizeMessage(message, request.folderId),
					),
					hasMore:
						count(json.Total) !== undefined
							? (page + 1) * size < Number(json.Total)
							: messages.length === size,
				};
				break;
			}
			case "create-folder": {
				const json = await api("core/v4/labels", "POST", {
					Name: request.name,
					Type: request.type === "label" ? 1 : 3,
					Color: "#8080FF",
				});
				result = { folder: normalizeFolder(record(json.Label)) };
				break;
			}
			case "create-filter":
			case "update-filter": {
				const previous =
					request.operation === "update-filter" &&
					(request.name === undefined ||
						request.sieve === undefined ||
						request.enabled === undefined)
						? record(
								(
									await api(
										`mail/v4/filters/${encodeURIComponent(request.id!)}`,
									)
								).Filter,
							)
						: undefined;
				if (
					previous &&
					(previous.ID !== request.id ||
						(request.name === undefined &&
							(typeof previous.Name !== "string" || !previous.Name.trim())) ||
						(request.sieve === undefined &&
							typeof previous.Sieve !== "string") ||
						(request.enabled === undefined &&
							previous.Status !== 0 &&
							previous.Status !== 1))
				) {
					throw new ProtonOperationError(
						"Proton returned an incomplete filter policy. Refresh the filter snapshot before retrying the reviewed update.",
					);
				}
				const body = {
					Name: request.name ?? previous?.Name,
					Sieve: request.sieve ?? previous?.Sieve,
					Status:
						request.enabled === undefined
							? previous?.Status ?? 1
							: request.enabled
								? 1
								: 0,
					Version: 2,
				};
				const json = await api(
					`mail/v4/filters${request.operation === "update-filter" ? `/${encodeURIComponent(request.id!)}` : ""}`,
					request.operation === "update-filter" ? "PUT" : "POST",
					body,
				);
				result = { filter: normalizeFilter(record(json.Filter)) };
				break;
			}
			case "delete-filter":
				await api(
					`mail/v4/filters/${encodeURIComponent(request.id!)}`,
					"DELETE",
				);
				result = {};
				break;
			case "move-messages":
				await api("mail/v4/messages/label", "PUT", {
					IDs: request.messageIds,
					LabelID: request.targetFolderId,
				});
				result = {};
				break;
			case "mark-read":
				await api("mail/v4/messages/read", "PUT", { IDs: request.messageIds });
				result = {};
				break;
			case "unlabel-messages":
				await api("mail/v4/messages/unlabel", "PUT", {
					IDs: request.messageIds,
					LabelID: request.labelId,
				});
				result = {};
				break;
		}
		return sanitizeInboxBrowserResponse(result);
	} finally {
		clearTimeout(timer);
	}
}
