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
	model?: string;
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

export const ISSUE_STATUSES = [
	"seen",
	"notified",
	"deferred",
	"fixing",
	"pr-open",
	"failed",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export type IssueEntry = {
	status: IssueStatus;
	firstSeen: string;
	prUrl?: string;
	at: string;
};

export type SinkEntry = {
	cursor?: string;
	lastPollAt?: string;
	lastError?: string;
	counts: Record<string, number>;
};

export type DepsRun = { windowStart: string; at: string; result: string };

export const PR_WATCH_KINDS = ["fix", "deps"] as const;
export type PrWatchKind = (typeof PR_WATCH_KINDS)[number];

export type PrWatchEntry = { repo: string; kind: PrWatchKind; startedAt: string };

export type ChannelState = {
	lastEventIds: Record<string, string>;
	current: CurrentJob | null;
	handled: Record<string, { status: HandledStatus; at: string; chatId?: string }>;
	blocked: Record<string, BlockedEntry>;
	issues: Record<string, IssueEntry>;
	sinks: Record<string, SinkEntry>;
	fixStarts: string[];
	deps: { lastRun: Record<string, DepsRun> };
	prWatch: Record<string, PrWatchEntry>;
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
	setIssue(id: string, entry: Omit<IssueEntry, "at">): void;
	updateSink(name: string, patch: Partial<SinkEntry>): void;
	recordFixStart(): void;
	recordDepsRun(repo: string, run: Omit<DepsRun, "at">): void;
	watchPr(url: string, entry: Omit<PrWatchEntry, "startedAt">): void;
	unwatchPr(url: string): void;
};

const HANDLED_STATUSES: readonly string[] = ["pending", "running", "done", "failed"];
const EVENT_SAVE_INTERVAL_MS = 1000;
const HANDLED_TTL_MS = 24 * 3_600_000;
const FIX_START_TTL_MS = 3_600_000;
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

function isIssueEntry(value: unknown): value is IssueEntry {
	return (
		isRecord(value) &&
		typeof value.status === "string" &&
		ISSUE_STATUSES.includes(value.status as IssueStatus) &&
		typeof value.firstSeen === "string" &&
		(value.prUrl === undefined || typeof value.prUrl === "string") &&
		typeof value.at === "string"
	);
}

function isSinkEntry(value: unknown): value is SinkEntry {
	return (
		isRecord(value) &&
		(value.cursor === undefined || typeof value.cursor === "string") &&
		(value.lastPollAt === undefined || typeof value.lastPollAt === "string") &&
		(value.lastError === undefined || typeof value.lastError === "string") &&
		isRecord(value.counts) &&
		Object.values(value.counts).every((count) => typeof count === "number")
	);
}

function isDepsRun(value: unknown): value is DepsRun {
	return (
		isRecord(value) &&
		typeof value.windowStart === "string" &&
		typeof value.at === "string" &&
		typeof value.result === "string"
	);
}

function isPrWatchEntry(value: unknown): value is PrWatchEntry {
	return (
		isRecord(value) &&
		typeof value.repo === "string" &&
		PR_WATCH_KINDS.includes(value.kind as PrWatchKind) &&
		typeof value.startedAt === "string"
	);
}

function parseFixStarts(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new TypeError("fixStarts must be an array of strings");
	}
	return value;
}

function parseDeps(value: unknown): ChannelState["deps"] {
	if (value === undefined) return { lastRun: {} };
	if (!isRecord(value)) throw new TypeError("deps must be an object");
	return { lastRun: validEntries(value.lastRun, "deps.lastRun", isDepsRun) };
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
		issues: {},
		sinks: {},
		fixStarts: [],
		deps: { lastRun: {} },
		prWatch: {},
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
			issues: validEntries(raw.issues, "issues", isIssueEntry),
			sinks: validEntries(raw.sinks, "sinks", isSinkEntry),
			fixStarts: parseFixStarts(raw.fixStarts),
			deps: parseDeps(raw.deps),
			prWatch: validEntries(raw.prWatch, "prWatch", isPrWatchEntry),
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
		setIssue(id, entry) {
			state.issues[id] = { ...entry, at: clock().toISOString() };
			save();
		},
		updateSink(name, patch) {
			state.sinks[name] = { ...(state.sinks[name] ?? { counts: {} }), ...patch };
			save();
		},
		recordFixStart() {
			const now = clock();
			state.fixStarts = state.fixStarts.filter(
				(at) => now.getTime() - Date.parse(at) < FIX_START_TTL_MS,
			);
			state.fixStarts.push(now.toISOString());
			save();
		},
		recordDepsRun(repo, run) {
			state.deps.lastRun[repo] = { ...run, at: clock().toISOString() };
			save();
		},
		watchPr(url, entry) {
			state.prWatch[url] = { ...entry, startedAt: clock().toISOString() };
			save();
		},
		unwatchPr(url) {
			delete state.prWatch[url];
			save();
		},
	};
}
