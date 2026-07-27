import {
	type MailboxInventory,
	preflightMailboxValue,
	validateMailboxInventory,
} from "@dg/common";
import {
	type MailboxAliasScope,
	type SessionAliasRegistry,
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

function category(value: unknown): string {
	return typeof value === "string" && MESSAGE_CATEGORIES.has(value)
		? value
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
