import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DgCliError, describeError, isRecord } from "@dg/common";
import { ensurePrivateDir, writeFileAtomic } from "@dg/common/node";
import type { RunnerName } from "./runners/types";
import type { PrHost } from "./verdict/types";

export type HandledStatus = "pending" | "running" | "done" | "failed";

export type BlockedOptions = {
	spice?: number;
	comment: boolean;
	fun: boolean;
	agent?: RunnerName;
};

export type CurrentJob = {
	messageId: string;
	chatId?: string;
	url: string;
	number: number;
	startedAt: string;
	pid?: number;
	pidStart?: string;
};

export type BlockedEntry = {
	url: string;
	messageId: string;
	chatId?: string;
	verdict: "changes_requested";
	options: BlockedOptions;
	at: string;
};

export type ChannelState = {
	lastEventIds: Record<string, string>;
	current: CurrentJob | null;
	handled: Record<string, { status: HandledStatus; at: string; chatId?: string }>;
	blocked: Record<string, BlockedEntry>;
};

export type StateStore = {
	get(): ChannelState;
	setLastEventId(chatId: string, id: string): void;
	flush(): void;
	setCurrent(current: CurrentJob | null): void;
	markHandled(messageId: string, status: HandledStatus, chatId?: string): void;
	markBlocked(
		url: string,
		messageId: string,
		options: BlockedOptions,
		chatId: string,
	): void;
	clearBlocked(url: string): void;
	pruneHandled(now: Date): void;
};

const HANDLED_STATUSES: readonly string[] = ["pending", "running", "done", "failed"];
const EVENT_SAVE_INTERVAL_MS = 1000;
const HANDLED_TTL_MS = 24 * 3_600_000;
const SEGMENT = "[A-Za-z0-9._-]+";
const PR_PATHS: Record<PrHost, RegExp> = {
	github: new RegExp(`^(/${SEGMENT}/${SEGMENT}/pull/\\d+)(?:/|$)`),
	gitlab: new RegExp(`^((?:/${SEGMENT}){2,}/-/merge_requests/\\d+)(?:/|$)`),
};

export function canonicalPrPath(host: PrHost, pathname: string): string | undefined {
	return pathname.match(PR_PATHS[host])?.[1];
}

export function prKey(url: string): string {
	if (!URL.canParse(url)) return url;
	const { protocol, host, pathname } = new URL(url);
	const path =
		canonicalPrPath("gitlab", pathname) ??
		canonicalPrPath("github", pathname) ??
		pathname.replace(/\/+$/, "");
	return `${protocol}//${host}${path}`;
}

function isCurrentJob(value: unknown): value is CurrentJob {
	return (
		isRecord(value) &&
		typeof value.messageId === "string" &&
		typeof value.url === "string" &&
		typeof value.number === "number" &&
		typeof value.startedAt === "string" &&
		(value.chatId === undefined || typeof value.chatId === "string") &&
		(value.pid === undefined || typeof value.pid === "number") &&
		(value.pidStart === undefined || typeof value.pidStart === "string")
	);
}

function isHandledEntry(value: unknown): value is ChannelState["handled"][string] {
	return (
		isRecord(value) &&
		typeof value.status === "string" &&
		HANDLED_STATUSES.includes(value.status) &&
		(value.chatId === undefined || typeof value.chatId === "string") &&
		typeof value.at === "string"
	);
}

function isBlockedEntry(value: unknown): value is BlockedEntry {
	return (
		isRecord(value) &&
		typeof value.url === "string" &&
		typeof value.messageId === "string" &&
		(value.chatId === undefined || typeof value.chatId === "string") &&
		value.verdict === "changes_requested" &&
		isRecord(value.options) &&
		typeof value.options.comment === "boolean" &&
		typeof value.options.fun === "boolean" &&
		typeof value.at === "string"
	);
}

function validEntries<T>(
	value: unknown,
	field: string,
	isValid: (entry: unknown) => entry is T,
): Record<string, T> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
	for (const [key, entry] of Object.entries(value)) {
		if (!isValid(entry)) throw new TypeError(`${field}.${key} is malformed`);
	}
	return value as Record<string, T>;
}

function parseCurrent(value: unknown): CurrentJob | null {
	if (value === undefined || value === null) return null;
	if (!isCurrentJob(value)) throw new TypeError("current is malformed");
	return value;
}

function parseEventIds(
	raw: Record<string, unknown>,
	legacyChatId: string | undefined,
): Record<string, string> {
	const ids: Record<string, string> = {};
	if (typeof raw.lastEventId === "string" && legacyChatId !== undefined) {
		ids[legacyChatId] = raw.lastEventId;
	}
	if (isRecord(raw.lastEventIds)) {
		for (const [chatId, id] of Object.entries(raw.lastEventIds)) {
			if (typeof id === "string") ids[chatId] = id;
		}
	}
	return ids;
}

function load(path: string, legacyChatId: string | undefined): ChannelState {
	const empty: ChannelState = {
		lastEventIds: {},
		current: null,
		handled: {},
		blocked: {},
	};
	if (!existsSync(path)) return empty;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(raw)) throw new TypeError("state must be an object");
		return {
			lastEventIds: parseEventIds(raw, legacyChatId),
			current: parseCurrent(raw.current),
			handled: validEntries(raw.handled, "handled", isHandledEntry),
			blocked: validEntries(raw.blocked, "blocked", isBlockedEntry),
		};
	} catch (err) {
		throw new DgCliError(`cannot read state file ${path}: ${describeError(err)}`);
	}
}

export function createStateStore(
	path: string,
	clock: () => Date = () => new Date(),
	eventSaveIntervalMs = EVENT_SAVE_INTERVAL_MS,
	legacyChatId?: string,
): StateStore {
	const state = load(path, legacyChatId);
	let eventTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSavedAt = 0;

	function save(): void {
		clearTimeout(eventTimer);
		eventTimer = undefined;
		ensurePrivateDir(dirname(path));
		writeFileAtomic(path, `${JSON.stringify(state, null, "\t")}\n`);
		lastSavedAt = Date.now();
	}

	return {
		get: () => state,
		setLastEventId(chatId, id) {
			state.lastEventIds[chatId] = id;
			if (eventTimer !== undefined) return;
			const wait = lastSavedAt + eventSaveIntervalMs - Date.now();
			if (wait <= 0) {
				save();
				return;
			}
			eventTimer = setTimeout(save, wait);
			eventTimer.unref();
		},
		flush() {
			if (eventTimer !== undefined) save();
		},
		setCurrent(current) {
			state.current = current;
			save();
		},
		markHandled(messageId, status, chatId) {
			state.handled[messageId] = { status, at: clock().toISOString(), chatId };
			save();
		},
		markBlocked(url, messageId, options, chatId) {
			const key = prKey(url);
			state.blocked[key] = {
				url: key,
				messageId,
				chatId,
				verdict: "changes_requested",
				options,
				at: clock().toISOString(),
			};
			save();
		},
		clearBlocked(url) {
			delete state.blocked[prKey(url)];
			save();
		},
		pruneHandled(now) {
			for (const [id, entry] of Object.entries(state.handled)) {
				if (now.getTime() - Date.parse(entry.at) > HANDLED_TTL_MS) {
					delete state.handled[id];
				}
			}
			save();
		},
	};
}
