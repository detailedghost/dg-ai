import {
	fail,
	requireFiniteNumber,
	requireOneOf,
	requireRecord,
	requireString,
} from "./assert";
import { DgCliError, EXIT_GENERAL_FAILURE } from "./errors";
import { validateProtoIdentifier } from "./proto-format";

const UTF8_ENCODER = new TextEncoder();

/** Byte length of `value` once JSON-serialized and UTF-8 encoded. */
export function jsonByteLength(value: unknown): number {
	return UTF8_ENCODER.encode(JSON.stringify(value)).length;
}

export const CHAT_PROTOCOL_VERSION = 1;

export const CHAT_MAX_PAYLOAD_BYTES = 1_048_576;
export const CHAT_MAX_MESSAGE_BODY_BYTES = 262_144;
export const CHAT_MAX_MANIFEST_BYTES = 65_536;
export const CHAT_MAX_ASSET_BYTES = 26_214_400;

/** Wire cost of one history item: its JSON bytes plus the array-separator byte. */
export function historyItemCost(item: unknown): number {
	return jsonByteLength(item) + 1;
}

export function fitHistoryPage<T>(items: T[], overheadBytes: number): T[] {
	let used = overheadBytes;
	let first = items.length;
	for (let i = items.length - 1; i >= 0; i--) {
		const cost = historyItemCost(items[i]);
		if (used + cost > CHAT_MAX_PAYLOAD_BYTES) break;
		used += cost;
		first = i;
	}
	return items.slice(first);
}

export const CHAT_DEFAULT_PORT = 47823;
export const CHAT_PORT_FALLBACK_COUNT = 9;

export const CHAT_MARKER_KEY = "_chat";

export const CHAT_HEALTH_PATH = "/healthz";
/** Answered alongside CHAT_HEALTH_PATH for one release, for extensions the user has not reloaded yet. */
export const CHAT_LEGACY_HEALTH_PATH = "/health";
export const CHAT_START_PATH = "/start";
export const CHAT_STATUS_PATH = "/status";
export const CHAT_WS_PATH = "/ws";
export const CHAT_CLI_PATH = "/cli";
export const CHAT_ASSETS_PATH = "/assets";
export const CHAT_JOBS_PATH = "/jobs";
export const CHAT_FEED_PATH = "/feed";
export const CHAT_SERVICES_PATH = "/services";

export type JobState = "ok" | "failed" | "paused";

/** Shared so the CLI and the dashboard cannot disagree on what counts as failed. */
export function deriveJobState(
	enabled: boolean,
	lastExitCode: number | null | undefined,
): JobState {
	if (!enabled) return "paused";
	if (
		lastExitCode !== null &&
		lastExitCode !== undefined &&
		lastExitCode !== 0
	) {
		return "failed";
	}
	return "ok";
}

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/** Render an interval the way `job add --every` accepts one. */
export function formatIntervalMs(intervalMs: number): string {
	if (intervalMs % MS_PER_HOUR === 0) return `${intervalMs / MS_PER_HOUR}h`;
	if (intervalMs % MS_PER_MINUTE === 0) {
		return `${intervalMs / MS_PER_MINUTE}m`;
	}
	return `${Math.max(1, Math.round(intervalMs / MS_PER_SECOND))}s`;
}

/** Render a job's schedule the way `job add` accepts one, for a cron job or an interval. */
export function formatSchedule(job: {
	intervalMs?: number | null;
	cronExpr?: string | null;
}): string {
	return job.cronExpr
		? `cron "${job.cronExpr}"`
		: `every ${formatIntervalMs(job.intervalMs ?? 0)}`;
}

const UNIT_MS: Record<string, number> = {
	s: 1_000,
	m: 60_000,
	h: 60 * 60_000,
};

const EVERY_RE = /^(\d+)([smh])$/;

/** Read an interval written the way a person writes one: `30s`, `15m`, `2h`. */
export function parseEvery(raw: string): number {
	const match = EVERY_RE.exec(raw.trim());
	if (!match) {
		throw new DgCliError(
			`--every: expected a count and a unit of s, m or h (for example 15m), got "${raw}"`,
			EXIT_GENERAL_FAILURE,
		);
	}
	const count = Number(match[1]);
	if (count <= 0) {
		throw new DgCliError(
			`--every: interval must be greater than zero, got "${raw}"`,
			EXIT_GENERAL_FAILURE,
		);
	}
	return count * UNIT_MS[match[2]];
}

export type SessionRole = "orchestrator" | "agent";

export type SessionSummary = {
	sessionId: string;
	agentIdentity: string;
	role: SessionRole;
	workset?: string;
};

export type CommandParam = { name: string; type: string };

export type CommandEntry = {
	label: string;
	argv: string[];
	params: CommandParam[];
};

export type ProgressState = "running" | "awaiting-input" | "agent-gone";

export type ChatErrorCode = "invalid-session";

export const OVERWATCH_SESSION_ID = "__overwatch__";

export const OVERWATCH_MAX_LANES = 100;
export const OVERWATCH_MAX_MERGES = 100;
export const OVERWATCH_MR_MAX_LENGTH = 80;
export const OVERWATCH_ETA_MAX_LENGTH = 80;
export const OVERWATCH_NEXT_MAX_LENGTH = 200;
export const OVERWATCH_URL_MAX_LENGTH = 2_048;
export const OVERWATCH_MERGE_TITLE_MAX_LENGTH = 200;

export type OverwatchStage = "review" | "ci" | "e2e" | "merge" | "done";

export type OverwatchLane = {
	chat: string;
	task: string;
	stage: OverwatchStage;
	mr?: string;
	eta?: string;
	next?: string;
	url?: string;
	kind: "chat" | "background";
	publisher: string;
	updatedAt: string;
};

export type OverwatchMerge = {
	mr: string;
	title: string;
	at: string;
};

export type OverwatchBoard = {
	goLive?: string;
	goNoGo?: string;
	lanes: OverwatchLane[];
	merges: OverwatchMerge[];
};

export type OverwatchAction = {
	chat: string;
	action: "reply" | "approve" | "reject";
	note?: string;
};

type Envelope<SessionId extends string = string> = {
	sessionId: SessionId;
	protocolVersion: number;
};

export type ChatFrame =
	| (Envelope & {
			type: "user-message";
			token: string;
			messageId: string;
			body: string;
			subagentName?: string;
	  })
	| (Envelope & { type: "ack"; messageId: string })
	| (Envelope & { type: "agent-message"; body: string; attachmentId?: string })
	| (Envelope & { type: "progress"; state: ProgressState })
	| (Envelope & {
			type: "command-invocation";
			token: string;
			commandLabel: string;
			params: Record<string, unknown>;
	  })
	| (Envelope & {
			type: "command-result";
			ok: boolean;
			output?: string;
			error?: string;
	  })
	| (Envelope & { type: "manifest-publish"; commands: CommandEntry[] })
	| (Envelope & { type: "session-list"; sessions: SessionSummary[] })
	| (Envelope & {
			type: "session-create";
			token: string;
			role: SessionRole;
			workset?: string;
			agentIdentity?: string;
	  })
	| (Envelope & {
			type: "session-pending";
			newSession: { sessionId: string; token: string };
	  })
	| (Envelope & { type: "keepalive"; token: string })
	| (Envelope & { type: "session-close"; token: string })
	| (Envelope & { type: "session-closed" })
	| (Envelope & { type: "history-request"; token: string })
	| (Envelope & { type: "history-response"; messages: unknown[] })
	| (Envelope & { type: "config-get"; token: string; key: string })
	| (Envelope & {
			type: "config-set";
			token: string;
			key: string;
			value: unknown;
	  })
	| (Envelope & {
			type: "error";
			message: string;
			code?: ChatErrorCode;
	  })
	| (Envelope & {
			type: "config-result";
			key: string;
			value?: unknown;
			error?: string;
	  })
	| (Envelope<typeof OVERWATCH_SESSION_ID> & {
			type: "overwatch-state";
			board: OverwatchBoard;
	  })
	| (Envelope<typeof OVERWATCH_SESSION_ID> & {
			type: "overwatch-open";
			requestId: string;
	  })
	| (Envelope & {
			type: "overwatch-open-result";
			token: string;
			requestId: string;
			ok: boolean;
			error?: string;
	  });

const CHAT_FRAME_TYPES = new Set([
	"user-message",
	"ack",
	"agent-message",
	"progress",
	"command-invocation",
	"command-result",
	"manifest-publish",
	"session-list",
	"session-create",
	"session-pending",
	"keepalive",
	"session-close",
	"session-closed",
	"history-request",
	"history-response",
	"config-get",
	"config-set",
	"error",
	"config-result",
	"overwatch-state",
	"overwatch-open",
	"overwatch-open-result",
]);

const INBOUND_FRAME_TYPES = new Set([
	"user-message",
	"command-invocation",
	"session-create",
	"session-close",
	"keepalive",
	"history-request",
	"config-get",
	"config-set",
	"overwatch-open-result",
]);

function requireProgressState(
	value: unknown,
	path: string,
): asserts value is ProgressState {
	requireOneOf(value, path, [
		"running",
		"awaiting-input",
		"agent-gone",
	] as const);
}

function requireRole(
	value: unknown,
	path: string,
): asserts value is SessionRole {
	requireOneOf(value, path, ["orchestrator", "agent"] as const);
}

function validateSessionSummary(value: unknown, path: string): SessionSummary {
	requireRecord(value, path);
	requireString(value.sessionId, `${path}.sessionId`, { nonEmpty: true });
	requireString(value.agentIdentity, `${path}.agentIdentity`, {
		nonEmpty: true,
	});
	requireRole(value.role, `${path}.role`);
	if (value.workset !== undefined) {
		requireString(value.workset, `${path}.workset`, { nonEmpty: true });
	}
	return value as SessionSummary;
}

function requireStringWithMaxLength(
	value: unknown,
	path: string,
	maxLength: number,
	options: { nonEmpty?: boolean } = {},
): asserts value is string {
	requireString(value, path, options);
	if (value.length > maxLength) {
		fail(`${path} must be at most ${maxLength} characters`);
	}
}

function requireOverwatchSessionId(
	value: unknown,
	path: string,
): asserts value is typeof OVERWATCH_SESSION_ID {
	if (value !== OVERWATCH_SESSION_ID) {
		fail(`${path} must be "${OVERWATCH_SESSION_ID}"`);
	}
}

const ISO_TIMESTAMP_RE =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export function validateIsoTimestamp(value: unknown, path: string): string {
	requireString(value, path, { nonEmpty: true });
	const match = ISO_TIMESTAMP_RE.exec(value);
	if (!match || Number.isNaN(Date.parse(value))) {
		fail(`${path} must be an ISO timestamp with a timezone`);
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const offsetHour = Number(match[8] ?? 0);
	const offsetMinute = Number(match[9] ?? 0);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1];
	if (
		daysInMonth === undefined ||
		day < 1 ||
		day > daysInMonth ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 14 ||
		offsetMinute > 59 ||
		(offsetHour === 14 && offsetMinute !== 0)
	) {
		fail(`${path} must be an ISO timestamp with a timezone`);
	}
	return value;
}

export function validateOverwatchLane(
	value: unknown,
	path = "overwatch lane",
): OverwatchLane {
	requireRecord(value, path);
	requireStringWithMaxLength(value.chat, `${path}.chat`, 40, {
		nonEmpty: true,
	});
	requireStringWithMaxLength(value.task, `${path}.task`, 80, {
		nonEmpty: true,
	});
	requireOneOf(value.stage, `${path}.stage`, [
		"review",
		"ci",
		"e2e",
		"merge",
		"done",
	] as const);
	for (const field of ["mr", "eta", "next"] as const) {
		if (value[field] !== undefined) {
			const limits = {
				mr: OVERWATCH_MR_MAX_LENGTH,
				eta: OVERWATCH_ETA_MAX_LENGTH,
				next: OVERWATCH_NEXT_MAX_LENGTH,
			} as const;
			const maxLength = limits[field];
			requireStringWithMaxLength(value[field], `${path}.${field}`, maxLength, {
				nonEmpty: true,
			});
		}
	}
	if (value.url !== undefined) {
		requireStringWithMaxLength(
			value.url,
			`${path}.url`,
			OVERWATCH_URL_MAX_LENGTH,
			{ nonEmpty: true },
		);
		if (!value.url.startsWith("https://claude.ai/")) {
			fail(`${path}.url must start with "https://claude.ai/"`);
		}
	}
	requireOneOf(value.kind, `${path}.kind`, ["chat", "background"] as const);
	requireStringWithMaxLength(value.publisher, `${path}.publisher`, 128, {
		nonEmpty: true,
	});
	validateIsoTimestamp(value.updatedAt, `${path}.updatedAt`);
	return value as OverwatchLane;
}

export function validateOverwatchMerge(
	value: unknown,
	path = "overwatch merge",
): OverwatchMerge {
	requireRecord(value, path);
	requireStringWithMaxLength(
		value.mr,
		`${path}.mr`,
		OVERWATCH_MR_MAX_LENGTH,
		{ nonEmpty: true },
	);
	requireStringWithMaxLength(
		value.title,
		`${path}.title`,
		OVERWATCH_MERGE_TITLE_MAX_LENGTH,
		{ nonEmpty: true },
	);
	validateIsoTimestamp(value.at, `${path}.at`);
	return value as OverwatchMerge;
}

function validateOverwatchBoard(
	value: unknown,
	path: string,
): OverwatchBoard {
	requireRecord(value, path);
	for (const field of ["goLive", "goNoGo"] as const) {
		if (value[field] !== undefined) {
			validateIsoTimestamp(value[field], `${path}.${field}`);
		}
	}
	if (!Array.isArray(value.lanes)) fail(`${path}.lanes must be an array`);
	if (value.lanes.length > OVERWATCH_MAX_LANES) {
		fail(`${path}.lanes must contain at most ${OVERWATCH_MAX_LANES} entries`);
	}
	value.lanes.forEach((lane, index) => {
		validateOverwatchLane(lane, `${path}.lanes[${index}]`);
	});
	if (!Array.isArray(value.merges)) fail(`${path}.merges must be an array`);
	if (value.merges.length > OVERWATCH_MAX_MERGES) {
		fail(`${path}.merges must contain at most ${OVERWATCH_MAX_MERGES} entries`);
	}
	value.merges.forEach((merge, index) => {
		validateOverwatchMerge(merge, `${path}.merges[${index}]`);
	});
	return value as OverwatchBoard;
}

export function validateOverwatchAction(
	value: unknown,
	path = "overwatch action",
): OverwatchAction {
	requireRecord(value, path);
	requireStringWithMaxLength(value.chat, `${path}.chat`, 40, {
		nonEmpty: true,
	});
	requireOneOf(value.action, `${path}.action`, [
		"reply",
		"approve",
		"reject",
	] as const);
	if (value.note !== undefined) {
		requireStringWithMaxLength(value.note, `${path}.note`, 2_000);
	}
	if (
		value.action === "reject" &&
		(typeof value.note !== "string" || value.note.trim().length === 0)
	) {
		fail(`${path}.note must be a non-empty string for reject`);
	}
	return value as OverwatchAction;
}

function validateFrameBody(
	type: string,
	value: Record<string, unknown>,
	path: string,
): void {
	switch (type) {
		case "user-message":
			requireString(value.messageId, `${path}.messageId`, { nonEmpty: true });
			requireString(value.body, `${path}.body`);
			if (value.subagentName !== undefined) {
				validateProtoIdentifier(value.subagentName, `${path}.subagentName`);
			}
			return;
		case "ack":
			requireString(value.messageId, `${path}.messageId`, { nonEmpty: true });
			return;
		case "agent-message":
			requireString(value.body, `${path}.body`);
			if (value.attachmentId !== undefined) {
				requireString(value.attachmentId, `${path}.attachmentId`, {
					nonEmpty: true,
				});
			}
			return;
		case "progress":
			requireProgressState(value.state, `${path}.state`);
			return;
		case "command-invocation":
			requireString(value.commandLabel, `${path}.commandLabel`, {
				nonEmpty: true,
			});
			requireRecord(value.params, `${path}.params`);
			return;
		case "command-result":
			if (typeof value.ok !== "boolean") fail(`${path}.ok must be a boolean`);
			if (value.output !== undefined)
				requireString(value.output, `${path}.output`);
			if (value.error !== undefined)
				requireString(value.error, `${path}.error`);
			return;
		case "manifest-publish":
			validateCommandManifest(value.commands, `${path}.commands`);
			return;
		case "session-list":
			if (!Array.isArray(value.sessions)) {
				fail(`${path}.sessions must be an array`);
			}
			value.sessions.forEach((entry, index) => {
				validateSessionSummary(entry, `${path}.sessions[${index}]`);
			});
			return;
		case "session-create":
			requireRole(value.role, `${path}.role`);
			if (value.workset !== undefined) {
				requireString(value.workset, `${path}.workset`, { nonEmpty: true });
			}
			if (value.agentIdentity !== undefined) {
				requireString(value.agentIdentity, `${path}.agentIdentity`, {
					nonEmpty: true,
				});
			}
			return;
		case "session-pending":
			requireRecord(value.newSession, `${path}.newSession`);
			requireString(
				value.newSession.sessionId,
				`${path}.newSession.sessionId`,
				{
					nonEmpty: true,
				},
			);
			requireString(value.newSession.token, `${path}.newSession.token`, {
				nonEmpty: true,
			});
			return;
		case "keepalive":
			return;
		case "session-close":
			return;
		case "session-closed":
			return;
		case "history-request":
			return;
		case "history-response":
			if (!Array.isArray(value.messages)) {
				fail(`${path}.messages must be an array`);
			}
			return;
		case "config-get":
			requireString(value.key, `${path}.key`, { nonEmpty: true });
			return;
		case "config-set":
			requireString(value.key, `${path}.key`, { nonEmpty: true });
			if (!Object.hasOwn(value, "value")) fail(`${path}.value is required`);
			return;
		case "error":
			requireString(value.message, `${path}.message`, { nonEmpty: true });
			if (value.code !== undefined && value.code !== "invalid-session") {
				fail(`${path}.code is not a known error code`);
			}
			return;
		case "config-result":
			requireString(value.key, `${path}.key`, { nonEmpty: true });
			if (value.error !== undefined) {
				requireString(value.error, `${path}.error`);
			}
			return;
		case "overwatch-state":
			requireOverwatchSessionId(value.sessionId, `${path}.sessionId`);
			validateOverwatchBoard(value.board, `${path}.board`);
			return;
		case "overwatch-open":
			requireOverwatchSessionId(value.sessionId, `${path}.sessionId`);
			requireString(value.requestId, `${path}.requestId`, { nonEmpty: true });
			return;
		case "overwatch-open-result":
			requireString(value.requestId, `${path}.requestId`, { nonEmpty: true });
			if (typeof value.ok !== "boolean") {
				fail(`${path}.ok must be a boolean`);
			}
			if (value.error !== undefined) {
				requireString(value.error, `${path}.error`, { nonEmpty: true });
			}
			if (!value.ok && value.error === undefined) {
				fail(`${path}.error is required when ok is false`);
			}
			return;
		default:
			fail(`${path}.type "${type}" is not a ratified discriminant`);
	}
}

export function validateChatFrame(value: unknown): ChatFrame {
	requireRecord(value, "chat frame");
	const { type } = value;
	if (typeof type !== "string" || !CHAT_FRAME_TYPES.has(type)) {
		fail(
			`chat frame.type must be one of the 22 ratified discriminants, got ${String(type)}`,
		);
	}
	requireString(value.sessionId, "chat frame.sessionId", { nonEmpty: true });
	requireFiniteNumber(value.protocolVersion, "chat frame.protocolVersion");

	if (INBOUND_FRAME_TYPES.has(type)) {
		requireString(value.token, "chat frame.token", { nonEmpty: true });
	} else if (Object.hasOwn(value, "token")) {
		fail(`chat frame.token must not be present on outbound "${type}" frames`);
	}

	validateFrameBody(type, value, "chat frame");

	const size = jsonByteLength(value);
	if (size > CHAT_MAX_PAYLOAD_BYTES) {
		fail(
			`chat frame exceeds CHAT_MAX_PAYLOAD_BYTES (${CHAT_MAX_PAYLOAD_BYTES})`,
		);
	}

	return value as ChatFrame;
}

function timingSafeEqualString(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}

export function authorizeFrame(
	frame: { type: string; sessionId: string; token?: unknown },
	capabilities: ReadonlyMap<string, string>,
): void {
	const token = frame.token;
	if (typeof token !== "string") {
		fail(`chat frame "${frame.type}" carries no token to authorize against`);
	}
	const expected = capabilities.get(frame.sessionId);
	if (expected === undefined || !timingSafeEqualString(expected, token)) {
		fail(`session ${frame.sessionId} is not authorized for this frame`);
	}
}

const WHOLE_PLACEHOLDER = /^\{([A-Za-z0-9_]+)\}$/;
const EMBEDDED_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

function validateArgvElement(
	value: unknown,
	path: string,
	paramNames: ReadonlySet<string>,
): void {
	requireString(value, path);
	const whole = WHOLE_PLACEHOLDER.exec(value);
	if (whole) {
		if (!paramNames.has(whole[1])) {
			fail(`${path} references undeclared param "${value}"`);
		}
		return;
	}
	for (const match of value.matchAll(EMBEDDED_PLACEHOLDER)) {
		if (paramNames.has(match[1])) {
			fail(
				`${path} embeds param placeholder "${match[0]}" within a larger element — a placeholder must occupy the WHOLE argv element`,
			);
		}
	}
}

export function validateCommandManifest(
	value: unknown,
	path = "command manifest",
): CommandEntry[] {
	if (!Array.isArray(value)) fail(`${path} must be an array`);

	value.forEach((entry, index) => {
		const entryPath = `${path}[${index}]`;
		requireRecord(entry, entryPath);
		if (Object.hasOwn(entry, "command")) {
			fail(`${entryPath} must declare argv, not a command string`);
		}
		requireString(entry.label, `${entryPath}.label`, { nonEmpty: true });
		if (!Array.isArray(entry.params)) {
			fail(`${entryPath}.params must be an array`);
		}
		const paramNames = new Set<string>();
		entry.params.forEach((param, paramIndex) => {
			const paramPath = `${entryPath}.params[${paramIndex}]`;
			requireRecord(param, paramPath);
			requireString(param.name, `${paramPath}.name`, { nonEmpty: true });
			requireString(param.type, `${paramPath}.type`, { nonEmpty: true });
			paramNames.add(param.name as string);
		});
		if (!Array.isArray(entry.argv)) fail(`${entryPath}.argv must be an array`);
		entry.argv.forEach((element, argvIndex) => {
			validateArgvElement(
				element,
				`${entryPath}.argv[${argvIndex}]`,
				paramNames,
			);
		});
	});

	return value as CommandEntry[];
}

export type DaemonHandle = {
	pid: number;
	port: number;
	instanceId: string;
	versions: { package: string; protocol: number };
};

export type SessionBootstrap = {
	port: number;
	sessionId: string;
	token: string;
	agentIdentity: string;
};

export function validateDaemonHandle(value: unknown): DaemonHandle {
	requireRecord(value, "daemon handle");
	if (Object.hasOwn(value, "token")) {
		fail("DaemonHandle (pid file) must never contain a session token");
	}
	requireFiniteNumber(value.pid, "daemon handle.pid");
	requireFiniteNumber(value.port, "daemon handle.port");
	requireString(value.instanceId, "daemon handle.instanceId", {
		nonEmpty: true,
	});
	requireRecord(value.versions, "daemon handle.versions");
	requireString(value.versions.package, "daemon handle.versions.package");
	requireFiniteNumber(
		value.versions.protocol,
		"daemon handle.versions.protocol",
	);
	return value as DaemonHandle;
}

export function validateSessionBootstrap(value: unknown): SessionBootstrap {
	requireRecord(value, "session bootstrap");
	requireFiniteNumber(value.port, "session bootstrap.port");
	requireString(value.sessionId, "session bootstrap.sessionId", {
		nonEmpty: true,
	});
	requireString(value.token, "session bootstrap.token", { nonEmpty: true });
	requireString(value.agentIdentity, "session bootstrap.agentIdentity", {
		nonEmpty: true,
	});
	return value as SessionBootstrap;
}
