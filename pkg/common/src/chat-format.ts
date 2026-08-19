import {
	fail,
	requireFiniteNumber,
	requireRecord,
	requireString,
} from "./assert";
import { validateProtoIdentifier } from "./proto-format";

/** Hand-versioned independently of the package version — bump on wire-format changes only. */
export const CHAT_PROTOCOL_VERSION = 1;

/** Fixed v1 size limits, mirroring PROTO_MAX_* naming in proto-format.ts. */
export const CHAT_MAX_PAYLOAD_BYTES = 1_048_576;
export const CHAT_MAX_MESSAGE_BODY_BYTES = 262_144;
export const CHAT_MAX_MANIFEST_BYTES = 65_536;
export const CHAT_MAX_ASSET_BYTES = 26_214_400;

/**
 * Fixed default port plus a deterministic fallback range (Code Structure's
 * transport ratification: slice 2 may add these here despite pkg/common
 * being absent from its file list).
 */
export const CHAT_DEFAULT_PORT = 47823;
export const CHAT_PORT_FALLBACK_COUNT = 9;

export type SessionRole = "orchestrator" | "agent";

/** Session-list entry; the daemon stores/echoes workset+role without interpreting them. */
export type SessionSummary = {
	sessionId: string;
	agentIdentity: string;
	role: SessionRole;
	workset?: string;
};

export type CommandParam = { name: string; type: string };

/** argv is a real argument vector; a placeholder occupies a WHOLE argv element. */
export type CommandEntry = {
	label: string;
	argv: string[];
	params: CommandParam[];
};

export type ProgressState = "running" | "awaiting-input" | "agent-gone";

type Envelope = { sessionId: string; protocolVersion: number };

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
	| (Envelope & { type: "error"; message: string });

/** The 18 ratified kebab-case discriminants — see plan.md's Slice-1 ratification subsection. */
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
]);

// Frames the socket receives; every other type is outbound and must never carry a token.
const INBOUND_FRAME_TYPES = new Set([
	"user-message",
	"command-invocation",
	"session-create",
	"session-close",
	"keepalive",
	"history-request",
	"config-get",
	"config-set",
]);

function requireProgressState(
	value: unknown,
	path: string,
): asserts value is ProgressState {
	if (
		value !== "running" &&
		value !== "awaiting-input" &&
		value !== "agent-gone"
	) {
		fail(`${path} must be "running", "awaiting-input", or "agent-gone"`);
	}
}

function requireRole(
	value: unknown,
	path: string,
): asserts value is SessionRole {
	if (value !== "orchestrator" && value !== "agent") {
		fail(`${path} must be "orchestrator" or "agent"`);
	}
}

/** Validate one session-list entry; workset stays optional and daemon-uninterpreted. */
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
		case "session-pending": {
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
		}
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
			return;
		default:
			fail(`${path}.type "${type}" is not a ratified discriminant`);
	}
}

/** Pure shape validation for the ChatFrame wire envelope — no authorization. */
export function validateChatFrame(value: unknown): ChatFrame {
	requireRecord(value, "chat frame");
	const { type } = value;
	if (typeof type !== "string" || !CHAT_FRAME_TYPES.has(type)) {
		fail(
			`chat frame.type must be one of the 18 ratified discriminants, got ${String(type)}`,
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

	const size = new TextEncoder().encode(JSON.stringify(value)).length;
	if (size > CHAT_MAX_PAYLOAD_BYTES) {
		fail(
			`chat frame exceeds CHAT_MAX_PAYLOAD_BYTES (${CHAT_MAX_PAYLOAD_BYTES})`,
		);
	}

	return value as ChatFrame;
}

// chat-format.ts is barrel-reachable and must stay node:-free, so the token
// compare is hand-rolled rather than node:crypto's timingSafeEqual.
function timingSafeEqualString(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
	}
	return diff === 0;
}

/** Authorize an already shape-valid frame against a session's known capability set. */
export function authorizeFrame(
	frame: { type: string; sessionId: string },
	capabilities: ReadonlyMap<string, string>,
): void {
	const token = (frame as { token?: unknown }).token;
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

/**
 * A whole-element placeholder must name a declared param (catches typos); an
 * embedded `{name}` is only rejected when `name` is itself a declared param —
 * anything else (jq/awk brace syntax) is a literal, not an attempted substitution.
 */
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

/** Validate a manifest's CommandEntry list; argv is a real argv, never a command string. */
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

/** One daemon, singleton lockfile — never a session token. */
export type DaemonHandle = {
	pid: number;
	port: number;
	instanceId: string;
	versions: { package: string; protocol: number };
};

/** One session's marker; distinct from SessionSummary, which lives only in session-list. */
export type SessionBootstrap = {
	port: number;
	sessionId: string;
	token: string;
	agentIdentity: string;
};

/**
 * Validate a value as the lockfile handle. Rejects a token unconditionally —
 * the caller (reading the known lockfile path) selects this branch, not the
 * attacker-controlled content, so a bootstrap-shaped payload with no `pid`
 * can no longer sneak a token through by omitting the field this used to key on.
 */
export function validateDaemonHandle(value: unknown): DaemonHandle {
	requireRecord(value, "daemon handle");
	if (Object.hasOwn(value, "token")) {
		fail("DaemonHandle (lockfile) must never contain a session token");
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

/** Validate a value as one session's bootstrap marker (never the lockfile). */
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

/**
 * Generic dispatch by shape — kept for callers with no a-priori expectation
 * of which kind they're reading. Prefer validateDaemonHandle/
 * validateSessionBootstrap wherever the caller already knows which file it opened.
 */
export function validateSessionHandle(
	value: unknown,
): DaemonHandle | SessionBootstrap {
	requireRecord(value, "session handle");
	return Object.hasOwn(value, "pid")
		? validateDaemonHandle(value)
		: validateSessionBootstrap(value);
}
