import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DgCliError, describeError, isRecord } from "@dg/common";
import {
	CHANNEL_REVIEW_SCHEMA_VERSION,
	CURRENT_SCHEMA_VERSION,
	openDaemonDatabase,
} from "@dg/common/daemon-db";
import { DEFAULT_BUSY_TIMEOUT_MS, ForwardOnlyVersionError, readSchemaVersion } from "@dg/common/node";
import type { ChannelReviewPaths } from "./paths";
import { RUNNER_NAMES, type RunnerName } from "./runners/types";
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
	execution?: {
		origin: "daemon" | "manual";
		backend: string;
		model?: string;
		modelSource: "requested" | "configured" | "default";
	};
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
	close(): void;
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
		(value.pidStart === undefined || typeof value.pidStart === "string") &&
		(value.execution === undefined ||
			(isRecord(value.execution) &&
				(value.execution.origin === "daemon" || value.execution.origin === "manual") &&
				typeof value.execution.backend === "string" &&
				(value.execution.model === undefined || typeof value.execution.model === "string") &&
				(value.execution.modelSource === "requested" || value.execution.modelSource === "configured" || value.execution.modelSource === "default")))
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
		(value.options.spice === undefined || (typeof value.options.spice === "number" && Number.isFinite(value.options.spice))) &&
		(value.options.agent === undefined || RUNNER_NAMES.includes(value.options.agent as RunnerName)) &&
		(value.options.model === undefined || typeof value.options.model === "string") &&
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
	Object.assign(ids, validEntries(raw.lastEventIds, "lastEventIds",
		(value): value is string => typeof value === "string"));
	if (raw.lastEventId !== undefined && typeof raw.lastEventId !== "string") {
		throw new TypeError("lastEventId must be a string");
	}
	return ids;
}

type StateLocation = Pick<ChannelReviewPaths, "env" | "dbPath" | "statePath">;
type StateRow = { state_json: string; revision: number };

function parseState(raw: unknown, legacyChatId?: string): ChannelState {
	if (!isRecord(raw)) throw new TypeError("state must be an object");
	return {
		...raw,
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
}

function loadLegacy(path: string, legacyChatId?: string): ChannelState {
	if (!existsSync(path)) return parseState({});
	try {
		return parseState(JSON.parse(readFileSync(path, "utf8")), legacyChatId);
	} catch (err) {
		throw new DgCliError(`cannot read state file ${path}: ${describeError(err)}`);
	}
}

function readRow(db: Database, env: string): StateRow | null {
	return db.query("SELECT state_json, revision FROM channel_review_state WHERE env = ?")
		.get(env) as StateRow | null;
}

/** Read-only inspection: never initializes a database or consumes the legacy import. */
export function readStateSnapshot(paths: StateLocation, legacyChatId?: string): ChannelState {
	if (!existsSync(paths.dbPath)) return loadLegacy(paths.statePath, legacyChatId);
	const db = new Database(paths.dbPath, { readonly: true, strict: true });
	try {
		db.run(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
		const version = readSchemaVersion(db);
		if (version > CURRENT_SCHEMA_VERSION) {
			throw new ForwardOnlyVersionError(version, CURRENT_SCHEMA_VERSION);
		}
		const row = version >= CHANNEL_REVIEW_SCHEMA_VERSION ? readRow(db, paths.env) : null;
		return row ? parseState(JSON.parse(row.state_json), legacyChatId)
			: loadLegacy(paths.statePath, legacyChatId);
	} finally {
		db.close(true);
	}
}

function initialize(db: Database, paths: StateLocation, legacyChatId?: string): StateRow {
	return db.transaction(() => {
		const existing = readRow(db, paths.env);
		if (existing) return existing;
		const imported = existsSync(paths.statePath);
		const state = loadLegacy(paths.statePath, legacyChatId);
		if ("lastEventId" in state && legacyChatId === undefined) {
			throw new DgCliError(`cannot import state file ${paths.statePath}: legacy lastEventId requires a chat id`);
		}
		delete (state as ChannelState & { lastEventId?: string }).lastEventId;
		const json = JSON.stringify(state);
		const now = new Date().toISOString();
		db.run(`INSERT INTO channel_review_state
			(env, state_json, updated_at, legacy_source, imported_at) VALUES (?, ?, ?, ?, ?)`,
			[paths.env, json, now, imported ? paths.statePath : null, imported ? now : null]);
		return { state_json: json, revision: 0 };
	}).immediate();
}

export function createStateStore(
	paths: StateLocation,
	clock: () => Date = () => new Date(),
	eventSaveIntervalMs = EVENT_SAVE_INTERVAL_MS,
	legacyChatId?: string,
): StateStore {
	const db = openDaemonDatabase({ dbPath: paths.dbPath, daemonDir: dirname(paths.dbPath) });
	let row: StateRow;
	let state: ChannelState;
	try {
		row = initialize(db, paths, legacyChatId);
		state = parseState(JSON.parse(row.state_json), legacyChatId);
	} catch (error) {
		db.close(false);
		throw error;
	}
	let revision = row.revision;
	let closed = false;
	let eventTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSavedAt = 0;

	function save(): void {
		clearTimeout(eventTimer);
		eventTimer = undefined;
		if (closed) throw new DgCliError("channel-review state store is closed");
		const result = db.run(`UPDATE channel_review_state
			SET state_json = ?, revision = revision + 1, updated_at = ?
			WHERE env = ? AND revision = ?`,
			[JSON.stringify(state), clock().toISOString(), paths.env, revision]);
		if (result.changes !== 1) {
			throw new DgCliError(`channel-review ${paths.env} state changed on another connection; reopen the store`);
		}
		revision++;
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
		close() {
			if (closed) return;
			try {
				if (eventTimer !== undefined) save();
			} finally {
				closed = true;
				db.close(true);
			}
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
