import {
	type MailboxInventory,
	preflightMailboxValue,
	validateMailboxInventory,
} from "@dg/common";
import {
	type MailboxAliasScope,
	type SessionAliasRegistry,
	isValidMailboxScopedAlias,
	validateMailboxAliasScope,
} from "./aliases";

export type RawMailboxInventory = Readonly<{
	accountName?: unknown;
	messages?: unknown;
	folders?: unknown;
	labels?: unknown;
	filters?: unknown;
}>;

export type MailboxScrubContext = MailboxAliasScope &
	Readonly<{
		capturedAt: string;
		partial?: boolean;
	}>;

export type MailboxScrubberDeps = Readonly<{
	aliases: SessionAliasRegistry;
}>;

export type MailboxLiveRawBindings = Readonly<Record<string, string>>;

const MESSAGE_CATEGORIES = new Set([
	"transactional",
	"newsletter",
	"notification",
	"social",
	"promotional",
	"personal",
]);

class MailboxScrubberError extends Error {
	override readonly name = "MailboxScrubberError";
}

function fail(code: "shape" | "field" | "timestamp"): never {
	throw new MailboxScrubberError(`Mailbox scrubber rejected ${code}`);
}

function record(value: unknown): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	) {
		fail("shape");
	}
	return value as Record<string, unknown>;
}

function list(value: unknown): readonly unknown[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) fail("shape");
	return value;
}

function rawId(item: Record<string, unknown>): string {
	if (
		typeof item.id !== "string" ||
		item.id.length === 0 ||
		item.id.length > 4096
	) {
		fail("field");
	}
	return item.id;
}

function bool(value: unknown, fallback = false): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") fail("field");
	return value;
}

function boundedCount(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > 1_000_000
	) {
		fail("field");
	}
	return value;
}

function timestamp(value: unknown): string {
	if (typeof value !== "string" || value.length > 32) fail("timestamp");
	const parsed = new Date(value);
	if (
		!Number.isFinite(parsed.getTime()) ||
		parsed.toISOString() !== value
	) {
		fail("timestamp");
	}
	return value;
}

function category(
	value: unknown,
): MailboxInventory["messages"][number]["category"] {
	return typeof value === "string" && MESSAGE_CATEGORIES.has(value)
		? (value as MailboxInventory["messages"][number]["category"])
		: "other";
}

function safeOptionalCount(key: string, value: unknown): Record<string, number> {
	const count = boundedCount(value);
	return count === undefined ? {} : { [key]: count };
}

/**
 * Converts provider page observations to the shared outbound inventory using
 * an allowlist. User-authored strings are never copied or transformed.
 */
export function scrubMailboxInventory(
	raw: RawMailboxInventory,
	context: MailboxScrubContext,
	deps: MailboxScrubberDeps,
): MailboxInventory {
	preflightMailboxValue(raw);
	preflightMailboxValue(context);
	const source = record(raw);
	const aliases = deps.aliases;
	const scope: MailboxAliasScope = {
		providerId: context.providerId,
		surface: context.surface,
		accountAlias: context.accountAlias,
		runAlias: context.runAlias,
		revisionAlias: context.revisionAlias,
	};
	validateMailboxAliasScope(scope);

	const messages = list(source.messages).map((candidate) => {
		const item = record(candidate);
		return {
			alias: aliases.bind(scope, "message", rawId(item)),
			read: bool(item.read),
			hasAttachments: bool(item.hasAttachments),
			receivedAt: timestamp(item.receivedAt),
			category: category(item.category),
		};
	});
	const folders = list(source.folders).map((candidate) => {
		const item = record(candidate);
		return {
			alias: aliases.bind(scope, "folder", rawId(item)),
			...safeOptionalCount("messageCount", item.messageCount),
		};
	});
	const labels = list(source.labels).map((candidate) => {
		const item = record(candidate);
		return {
			alias: aliases.bind(scope, "label", rawId(item)),
			...safeOptionalCount("messageCount", item.messageCount),
		};
	});
	const filters = list(source.filters).map((candidate) => {
		const item = record(candidate);
		return {
			alias: aliases.bind(scope, "filter", rawId(item)),
			active: bool(item.active, true),
		};
	});

	return validateMailboxInventory({
		schemaVersion: 1,
		providerId: context.providerId,
		surface: context.surface,
		accountAlias: context.accountAlias,
		runAlias: context.runAlias,
		capturedAt: timestamp(context.capturedAt),
		partial: bool(context.partial),
		messages,
		folders,
		labels,
		filters,
	});
}

/**
 * Reconstructs a fresh, sanitized fingerprint inventory after a worker
 * restart. Only raw IDs already present in the scoped session bindings are
 * admitted; unrelated fresh mail is ignored and no raw snapshot is retained.
 */
export function scrubFreshMailboxInventoryFromBindings(
	raw: RawMailboxInventory,
	context: MailboxScrubContext,
	bindings: MailboxLiveRawBindings,
): MailboxInventory {
	preflightMailboxValue(raw);
	preflightMailboxValue(context);
	preflightMailboxValue(bindings);
	const source = record(raw);
	const scope: MailboxAliasScope = {
		providerId: context.providerId,
		surface: context.surface,
		accountAlias: context.accountAlias,
		runAlias: context.runAlias,
		revisionAlias: context.revisionAlias,
	};
	validateMailboxAliasScope(scope);
	if (
		bindings === null ||
		typeof bindings !== "object" ||
		Array.isArray(bindings) ||
		Object.keys(bindings).length > 10_000
	) {
		fail("shape");
	}
	const byRaw = {
		msg: new Map<string, string>(),
		fld: new Map<string, string>(),
		lbl: new Map<string, string>(),
		flt: new Map<string, string>(),
	};
	for (const [alias, rawValue] of Object.entries(bindings)) {
		const prefix = alias.slice(0, alias.indexOf("_"));
		if (
			(prefix !== "msg" &&
				prefix !== "fld" &&
				prefix !== "lbl" &&
				prefix !== "flt") ||
			!isValidMailboxScopedAlias(alias, prefix) ||
			typeof rawValue !== "string" ||
			rawValue.length === 0 ||
			rawValue.length > 4096 ||
			byRaw[prefix].has(rawValue)
		) {
			fail("field");
		}
		byRaw[prefix].set(rawValue, alias);
	}
	const messages: MailboxInventory["messages"][number][] = [];
	for (const candidate of list(source.messages)) {
		const item = record(candidate);
		const alias = byRaw.msg.get(rawId(item));
		if (alias === undefined) continue;
		messages.push({
			alias,
			read: bool(item.read),
			hasAttachments: bool(item.hasAttachments),
			receivedAt: timestamp(item.receivedAt),
			category: category(item.category),
		});
	}
	const folders: MailboxInventory["folders"][number][] = [];
	for (const candidate of list(source.folders)) {
		const item = record(candidate);
		const alias = byRaw.fld.get(rawId(item));
		if (alias === undefined) continue;
		folders.push({
			alias,
			...safeOptionalCount("messageCount", item.messageCount),
		});
	}
	const labels: MailboxInventory["labels"][number][] = [];
	for (const candidate of list(source.labels)) {
		const item = record(candidate);
		const alias = byRaw.lbl.get(rawId(item));
		if (alias === undefined) continue;
		labels.push({
			alias,
			...safeOptionalCount("messageCount", item.messageCount),
		});
	}
	const filters: MailboxInventory["filters"][number][] = [];
	for (const candidate of list(source.filters)) {
		const item = record(candidate);
		const alias = byRaw.flt.get(rawId(item));
		if (alias === undefined) continue;
		filters.push({
			alias,
			active: bool(item.active, true),
		});
	}
	return validateMailboxInventory({
		schemaVersion: 1,
		providerId: context.providerId,
		surface: context.surface,
		accountAlias: context.accountAlias,
		runAlias: context.runAlias,
		capturedAt: timestamp(context.capturedAt),
		partial: bool(context.partial),
		messages,
		folders,
		labels,
		filters,
	});
}
