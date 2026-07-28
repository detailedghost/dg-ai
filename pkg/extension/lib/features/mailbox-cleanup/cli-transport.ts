import {
	MAILBOX_REASON_CODES,
	preflightMailboxValue,
	validateMailboxPlanRevision,
	type MailboxReasonCode,
} from "@dg/common";
import type {
	MailboxChatSubmitMessage,
	MailboxChatSubmitResult,
} from "./bridge";
import {
	MAILBOX_PLAN_LIST_STATES,
	MAILBOX_PLAN_STALE_REASONS,
	type MailboxPlanListActionResult,
	type MailboxPlanListCommand,
	type MailboxPlanListCommandType,
	type MailboxPlanListQuery,
	type MailboxPlanListResult,
	type MailboxPlanListRow,
} from "./plan-workspace/list";

export const MAILBOX_CLI_CONNECT_TYPE =
	"dg-mailbox-cleanup:cli-connect" as const;
export const MAILBOX_CLI_APPROVAL_INSPECT_TYPE =
	"dg-mailbox-cleanup:cli-approval-inspect" as const;
export const MAILBOX_CLI_APPROVAL_DECISION_TYPE =
	"dg-mailbox-cleanup:cli-approval-decision" as const;
export const MAILBOX_CLI_MARKER_KEY = "_dg_mailbox_cli";
export const MAILBOX_PLANS_CLI_REQUEST_TYPE =
	"dg_mailbox_plans_request" as const;
export const MAILBOX_PLANS_CLI_TERMINAL_TYPE =
	"dg_mailbox_plans_terminal" as const;
const RUN_ALIAS = /^run_[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const APPROVAL_ALIAS = /^cli_[a-f0-9]{32}$/;
const REQUEST_ALIAS = /^req_[a-f0-9]{32}$/;
const PLAN_ALIAS = /^plan_[a-f0-9]{32}$/;
const REVISION_ALIAS = /^rev_[a-f0-9]{32}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SURFACE = /^[a-z][a-z0-9_-]{0,63}$/;
const ACCOUNT_ALIAS = /^acct_[a-f0-9]{32}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_MARKER_LENGTH = 2_048;
const MAX_AUTHOR_RESULT_BYTES = 2_000_000;
const DEFAULT_PLANS_MONITOR_INTERVAL_MS = 50;
const DEFAULT_PLANS_MONITOR_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_PLANS_MONITOR_MAX_DURATION_MS = 10 * 60_000;

export type MailboxCliConnection = Readonly<{
	schemaVersion: 1;
	origin: string;
	runAlias: string;
	nonce: string;
	token: string;
	purpose?: "plans";
}>;

export type MailboxPlansCliRequest =
	| Readonly<{
			schemaVersion: 1;
			type: typeof MAILBOX_PLANS_CLI_REQUEST_TYPE;
			requestAlias: string;
			operation: "list";
			query: MailboxPlanListQuery;
	  }>
	| Readonly<{
			schemaVersion: 1;
			type: typeof MAILBOX_PLANS_CLI_REQUEST_TYPE;
			requestAlias: string;
			operation: MailboxPlanListCommandType;
			command: MailboxPlanListCommand;
	  }>;

export type MailboxPlansCliTerminal =
	| Readonly<{
			schemaVersion: 1;
			type: typeof MAILBOX_PLANS_CLI_TERMINAL_TYPE;
			requestAlias: string;
			operation: "list";
			status: "completed";
			result: MailboxPlanListResult;
	  }>
	| Readonly<{
			schemaVersion: 1;
			type: typeof MAILBOX_PLANS_CLI_TERMINAL_TYPE;
			requestAlias: string;
			operation: MailboxPlanListCommandType;
			status: "completed";
			result: MailboxPlanListActionResult;
	  }>
	| Readonly<{
			schemaVersion: 1;
			type: typeof MAILBOX_PLANS_CLI_TERMINAL_TYPE;
			requestAlias: string;
			operation: "list" | MailboxPlanListCommandType;
			status: "canceled";
	  }>
	| Readonly<{
			schemaVersion: 1;
			type: typeof MAILBOX_PLANS_CLI_TERMINAL_TYPE;
			requestAlias: string;
			operation: "list" | MailboxPlanListCommandType;
			status: "error";
			code: MailboxReasonCode;
			retryable: boolean;
	  }>;

export type MailboxPlansCliSessionMonitor = Readonly<{
	signal: AbortSignal;
	dispose(): void;
}>;

export type MailboxCliConnectEnvelope = Readonly<{
	type: typeof MAILBOX_CLI_CONNECT_TYPE;
	connection: MailboxCliConnection;
}>;

export type MailboxCliRuntimeSender = Readonly<{
	id?: string;
	url?: string;
	frameId?: number;
	tab?: Readonly<{
		id?: number;
		url?: string;
	}>;
}>;

export type MailboxCliApprovalDecision = "approve" | "deny";

export type MailboxCliApprovalEnvelope =
	| Readonly<{
			type: typeof MAILBOX_CLI_APPROVAL_INSPECT_TYPE;
			approvalAlias: string;
	  }>
	| Readonly<{
			type: typeof MAILBOX_CLI_APPROVAL_DECISION_TYPE;
			approvalAlias: string;
			decision: MailboxCliApprovalDecision;
	  }>;

export type MailboxCliApprovalView = Readonly<{
	schemaVersion: 1;
	origin: string;
	runAlias: string;
	expiresAt: string;
}>;

function exact(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error("Invalid mailbox CLI connection");
	}
	const input = value as Record<string, unknown>;
	const allowed = new Set([...required, ...optional]);
	if (
		required.some((key) => !Object.hasOwn(input, key)) ||
		Object.keys(input).some((key) => !allowed.has(key))
	) {
		throw new Error("Invalid mailbox CLI connection");
	}
	return input;
}

function loopbackOrigin(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("Invalid mailbox CLI connection");
	}
	const parsed = new URL(value);
	if (
		parsed.protocol !== "http:" ||
		parsed.hostname !== "127.0.0.1" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.pathname !== "/" ||
		parsed.search !== "" ||
		parsed.hash !== "" ||
		parsed.port === ""
	) {
		throw new Error("Invalid mailbox CLI connection");
	}
	const port = Number(parsed.port);
	if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
		throw new Error("Invalid mailbox CLI connection");
	}
	return parsed.origin;
}

function connection(value: unknown): MailboxCliConnection {
	const candidate =
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
			? (value as Record<string, unknown>)
			: undefined;
	const input = exact(
		value,
		candidate?.purpose === "plans"
			? [
					"schemaVersion",
					"origin",
					"runAlias",
					"nonce",
					"token",
					"purpose",
				]
			: ["schemaVersion", "origin", "runAlias", "nonce", "token"],
	);
	if (
		input.schemaVersion !== 1 ||
		typeof input.runAlias !== "string" ||
		!RUN_ALIAS.test(input.runAlias) ||
		typeof input.nonce !== "string" ||
		!NONCE.test(input.nonce) ||
		typeof input.token !== "string" ||
		!TOKEN.test(input.token)
	) {
		throw new Error("Invalid mailbox CLI connection");
	}
	return Object.freeze({
		schemaVersion: 1,
		origin: loopbackOrigin(input.origin),
		runAlias: input.runAlias,
		nonce: input.nonce,
		token: input.token,
		...(input.purpose === "plans"
			? { purpose: "plans" as const }
			: {}),
	});
}

function decodeMarker(value: string): unknown {
	if (
		value.length === 0 ||
		value.length > MAX_MARKER_LENGTH ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	) {
		throw new Error("Invalid mailbox CLI marker");
	}
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	const bytes = Uint8Array.from(atob(padded), (character) =>
		character.charCodeAt(0),
	);
	return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function parseMailboxCliMarker(url: string): MailboxCliConnection | undefined {
	const parsed = new URL(url);
	const entries = parsed.hash.startsWith("#")
		? parsed.hash.slice(1).split("&")
		: [];
	const markerEntries = entries.filter(
		(entry) => entry.split("=", 1)[0] === MAILBOX_CLI_MARKER_KEY,
	);
	if (markerEntries.length === 0) return undefined;
	if (markerEntries.length !== 1 || entries.length !== 1) {
		throw new Error("Invalid mailbox CLI marker");
	}
	const encoded = markerEntries[0]?.slice(MAILBOX_CLI_MARKER_KEY.length + 1);
	const result = connection(decodeMarker(encoded ?? ""));
	if (
		parsed.origin !== result.origin ||
		parsed.pathname !==
			`/mailbox-cleanup/v1/connect/${result.runAlias}` ||
		parsed.search !== ""
	) {
		throw new Error("Invalid mailbox CLI marker");
	}
	return result;
}

export function stripMailboxCliMarker(url: string): string {
	const parsed = new URL(url);
	parsed.hash = "";
	return parsed.toString();
}

export function validateMailboxCliConnectEnvelope(
	value: unknown,
): MailboxCliConnectEnvelope | undefined {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(value as { type?: unknown }).type !== MAILBOX_CLI_CONNECT_TYPE
	) {
		return undefined;
	}
	const input = exact(value, ["type", "connection"]);
	return Object.freeze({
		type: MAILBOX_CLI_CONNECT_TYPE,
		connection: connection(input.connection),
	});
}

export function validateMailboxCliApprovalEnvelope(
	value: unknown,
): MailboxCliApprovalEnvelope | undefined {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return undefined;
	}
	const type = (value as { type?: unknown }).type;
	if (type === MAILBOX_CLI_APPROVAL_INSPECT_TYPE) {
		const input = exact(value, ["type", "approvalAlias"]);
		if (
			typeof input.approvalAlias !== "string" ||
			!APPROVAL_ALIAS.test(input.approvalAlias)
		) {
			throw new Error("Invalid mailbox CLI approval");
		}
		return Object.freeze({
			type,
			approvalAlias: input.approvalAlias,
		});
	}
	if (type === MAILBOX_CLI_APPROVAL_DECISION_TYPE) {
		const input = exact(value, ["type", "approvalAlias", "decision"]);
		if (
			typeof input.approvalAlias !== "string" ||
			!APPROVAL_ALIAS.test(input.approvalAlias) ||
			(input.decision !== "approve" && input.decision !== "deny")
		) {
			throw new Error("Invalid mailbox CLI approval");
		}
		return Object.freeze({
			type,
			approvalAlias: input.approvalAlias,
			decision: input.decision,
		});
	}
	return undefined;
}

function plansQuery(value: unknown): MailboxPlanListQuery {
	const input = exact(
		value,
		["states", "stale"],
		["providerId", "surface", "accountAlias"],
	);
	if (
		!Array.isArray(input.states) ||
		input.states.length > MAILBOX_PLAN_LIST_STATES.length ||
		new Set(input.states).size !== input.states.length ||
		input.states.some(
			(state) =>
				typeof state !== "string" ||
				!MAILBOX_PLAN_LIST_STATES.includes(
					state as (typeof MAILBOX_PLAN_LIST_STATES)[number],
				),
		) ||
		!["all", "only", "exclude"].includes(String(input.stale)) ||
		(input.providerId !== undefined &&
			(typeof input.providerId !== "string" ||
				!PROVIDER_ID.test(input.providerId))) ||
		(input.surface !== undefined &&
			(typeof input.surface !== "string" ||
				!SURFACE.test(input.surface))) ||
		(input.accountAlias !== undefined &&
			(typeof input.accountAlias !== "string" ||
				!ACCOUNT_ALIAS.test(input.accountAlias)))
	) {
		throw new Error("Invalid mailbox plans CLI request");
	}
	return Object.freeze({
		states: Object.freeze(
			input.states as (typeof MAILBOX_PLAN_LIST_STATES)[number][],
		),
		stale: input.stale as "all" | "only" | "exclude",
		...(input.providerId === undefined
			? {}
			: { providerId: input.providerId as string }),
		...(input.surface === undefined
			? {}
			: { surface: input.surface as string }),
		...(input.accountAlias === undefined
			? {}
			: { accountAlias: input.accountAlias as string }),
	});
}

function plansCommand(
	value: unknown,
	operation: MailboxPlanListCommandType,
	requestAlias: string,
): MailboxPlanListCommand {
	const input = exact(value, [
		"schemaVersion",
		"type",
		"planAlias",
		"revisionAlias",
		"requestAlias",
	]);
	if (
		input.schemaVersion !== 1 ||
		input.type !== operation ||
		input.requestAlias !== requestAlias ||
		typeof input.planAlias !== "string" ||
		!PLAN_ALIAS.test(input.planAlias) ||
		typeof input.revisionAlias !== "string" ||
		!REVISION_ALIAS.test(input.revisionAlias)
	) {
		throw new Error("Invalid mailbox plans CLI request");
	}
	return Object.freeze({
		schemaVersion: 1,
		type: operation,
		planAlias: input.planAlias,
		revisionAlias: input.revisionAlias,
		requestAlias,
	});
}

export function validateMailboxPlansCliRequest(
	value: unknown,
): MailboxPlansCliRequest {
	preflightMailboxValue(value, {
		maxNodes: 100,
		maxKeys: 100,
		maxArrayLength: MAILBOX_PLAN_LIST_STATES.length,
		maxTotalStringLength: 2_048,
		maxTotalBytes: 8_192,
	});
	const input = exact(
		value,
		(value as { operation?: unknown })?.operation === "list"
			? [
					"schemaVersion",
					"type",
					"requestAlias",
					"operation",
					"query",
				]
			: [
					"schemaVersion",
					"type",
					"requestAlias",
					"operation",
					"command",
				],
	);
	if (
		input.schemaVersion !== 1 ||
		input.type !== MAILBOX_PLANS_CLI_REQUEST_TYPE ||
		typeof input.requestAlias !== "string" ||
		!REQUEST_ALIAS.test(input.requestAlias)
	) {
		throw new Error("Invalid mailbox plans CLI request");
	}
	if (input.operation === "list") {
		return Object.freeze({
			schemaVersion: 1,
			type: MAILBOX_PLANS_CLI_REQUEST_TYPE,
			requestAlias: input.requestAlias,
			operation: "list",
			query: plansQuery(input.query),
		});
	}
	if (
		!["edit", "preflight", "focus", "resume", "restart"].includes(
			String(input.operation),
		)
	) {
		throw new Error("Invalid mailbox plans CLI request");
	}
	const operation = input.operation as MailboxPlanListCommandType;
	return Object.freeze({
		schemaVersion: 1,
		type: MAILBOX_PLANS_CLI_REQUEST_TYPE,
		requestAlias: input.requestAlias,
		operation,
		command: plansCommand(input.command, operation, input.requestAlias),
	});
}

function timestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		TIMESTAMP.test(value) &&
		new Date(value).toISOString() === value
	);
}

function plansRow(value: unknown): MailboxPlanListRow {
	const input = exact(value, [
		"schemaVersion",
		"planAlias",
		"revisionAlias",
		"providerId",
		"surface",
		"accountAlias",
		"lifecycleState",
		"stale",
		"staleReason",
		"updatedAt",
		"expiresAt",
		"nextAction",
	]);
	const next = exact(input.nextAction, ["type"]);
	if (
		input.schemaVersion !== 1 ||
		typeof input.planAlias !== "string" ||
		!PLAN_ALIAS.test(input.planAlias) ||
		typeof input.revisionAlias !== "string" ||
		!REVISION_ALIAS.test(input.revisionAlias) ||
		typeof input.providerId !== "string" ||
		!PROVIDER_ID.test(input.providerId) ||
		typeof input.surface !== "string" ||
		!SURFACE.test(input.surface) ||
		(input.accountAlias !== null &&
			(typeof input.accountAlias !== "string" ||
				!ACCOUNT_ALIAS.test(input.accountAlias))) ||
		!MAILBOX_PLAN_LIST_STATES.includes(
			input.lifecycleState as (typeof MAILBOX_PLAN_LIST_STATES)[number],
		) ||
		typeof input.stale !== "boolean" ||
		!MAILBOX_PLAN_STALE_REASONS.includes(
			input.staleReason as (typeof MAILBOX_PLAN_STALE_REASONS)[number],
		) ||
		(input.stale
			? input.staleReason === "none"
			: input.staleReason !== "none" &&
				input.staleReason !== "check_required") ||
		!timestamp(input.updatedAt) ||
		!timestamp(input.expiresAt) ||
		!["edit", "preflight", "focus", "resume", "restart", "view"].includes(
			String(next.type),
		)
	) {
		throw new Error("Invalid mailbox plans CLI terminal");
	}
	return Object.freeze({
		schemaVersion: 1,
		planAlias: input.planAlias,
		revisionAlias: input.revisionAlias,
		providerId: input.providerId,
		surface: input.surface,
		accountAlias: input.accountAlias as string | null,
		lifecycleState:
			input.lifecycleState as MailboxPlanListRow["lifecycleState"],
		stale: input.stale,
		staleReason: input.staleReason as MailboxPlanListRow["staleReason"],
		updatedAt: input.updatedAt,
		expiresAt: input.expiresAt,
		nextAction: Object.freeze({
			type: next.type as MailboxPlanListRow["nextAction"]["type"],
		}),
	});
}

function plansListResult(value: unknown): MailboxPlanListResult {
	const input = exact(value, ["schemaVersion", "rows"]);
	if (
		input.schemaVersion !== 1 ||
		!Array.isArray(input.rows) ||
		input.rows.length > 10_000
	) {
		throw new Error("Invalid mailbox plans CLI terminal");
	}
	const rows = input.rows.map(plansRow);
	return Object.freeze({ schemaVersion: 1, rows: Object.freeze(rows) });
}

function plansActionResult(
	value: unknown,
	operation: MailboxPlanListCommandType,
	requestAlias: string,
): MailboxPlanListActionResult {
	const status = (value as { status?: unknown })?.status;
	const input = exact(
		value,
		status === "completed"
			? [
					"schemaVersion",
					"status",
					"requestAlias",
					"action",
					"planAlias",
					"revisionAlias",
					"lifecycleState",
					"preservedApproval",
				]
			: status === "blocked"
				? [
						"schemaVersion",
						"status",
						"requestAlias",
						"action",
						"reason",
					]
				: [
						"schemaVersion",
						"status",
						"requestAlias",
						"action",
					],
	);
	if (
		input.schemaVersion !== 1 ||
		input.requestAlias !== requestAlias ||
		input.action !== operation
	) {
		throw new Error("Invalid mailbox plans CLI terminal");
	}
	if (input.status === "canceled") {
		return Object.freeze({
			schemaVersion: 1,
			status: "canceled",
			requestAlias,
			action: operation,
		});
	}
	if (input.status === "blocked") {
		if (
			typeof input.reason !== "string" ||
			!MAILBOX_PLAN_STALE_REASONS.includes(
				input.reason as (typeof MAILBOX_PLAN_STALE_REASONS)[number],
			) ||
			input.reason === "none" ||
			input.reason === "check_required"
		) {
			throw new Error("Invalid mailbox plans CLI terminal");
		}
		return Object.freeze({
			schemaVersion: 1,
			status: "blocked",
			requestAlias,
			action: operation,
			reason: input.reason as Extract<
				MailboxPlanListActionResult,
				{ status: "blocked" }
			>["reason"],
		});
	}
	if (
		input.status !== "completed" ||
		typeof input.planAlias !== "string" ||
		!PLAN_ALIAS.test(input.planAlias) ||
		typeof input.revisionAlias !== "string" ||
		!REVISION_ALIAS.test(input.revisionAlias) ||
		!MAILBOX_PLAN_LIST_STATES.includes(
			input.lifecycleState as (typeof MAILBOX_PLAN_LIST_STATES)[number],
		) ||
		typeof input.preservedApproval !== "boolean"
	) {
		throw new Error("Invalid mailbox plans CLI terminal");
	}
	return Object.freeze({
		schemaVersion: 1,
		status: "completed",
		requestAlias,
		action: operation,
		planAlias: input.planAlias,
		revisionAlias: input.revisionAlias,
		lifecycleState:
			input.lifecycleState as Extract<
				MailboxPlanListActionResult,
				{ status: "completed" }
			>["lifecycleState"],
		preservedApproval: input.preservedApproval,
	});
}

export function validateMailboxPlansCliTerminal(
	value: unknown,
	expected?: Pick<MailboxPlansCliRequest, "requestAlias" | "operation">,
): MailboxPlansCliTerminal {
	preflightMailboxValue(value, {
		maxNodes: 150_000,
		maxKeys: 150_000,
		maxArrayLength: 10_000,
		maxTotalStringLength: 1_000_000,
		maxTotalBytes: MAX_AUTHOR_RESULT_BYTES,
	});
	const status = (value as { status?: unknown })?.status;
	const input = exact(
		value,
		status === "completed"
			? [
					"schemaVersion",
					"type",
					"requestAlias",
					"operation",
					"status",
					"result",
				]
			: status === "error"
				? [
						"schemaVersion",
						"type",
						"requestAlias",
						"operation",
						"status",
						"code",
						"retryable",
					]
				: [
						"schemaVersion",
						"type",
						"requestAlias",
						"operation",
						"status",
					],
	);
	if (
		input.schemaVersion !== 1 ||
		input.type !== MAILBOX_PLANS_CLI_TERMINAL_TYPE ||
		typeof input.requestAlias !== "string" ||
		!REQUEST_ALIAS.test(input.requestAlias) ||
		(expected !== undefined &&
			(input.requestAlias !== expected.requestAlias ||
				input.operation !== expected.operation)) ||
		!["list", "edit", "preflight", "focus", "resume", "restart"].includes(
			String(input.operation),
		)
	) {
		throw new Error("Invalid mailbox plans CLI terminal");
	}
	const operation = input.operation as MailboxPlansCliRequest["operation"];
	if (input.status === "canceled") {
		return Object.freeze({
			schemaVersion: 1,
			type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
			requestAlias: input.requestAlias,
			operation,
			status: "canceled",
		});
	}
	if (input.status === "error") {
		if (
			typeof input.code !== "string" ||
			!MAILBOX_REASON_CODES.includes(input.code as MailboxReasonCode) ||
			typeof input.retryable !== "boolean"
		) {
			throw new Error("Invalid mailbox plans CLI terminal");
		}
		return Object.freeze({
			schemaVersion: 1,
			type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
			requestAlias: input.requestAlias,
			operation,
			status: "error",
			code: input.code as MailboxReasonCode,
			retryable: input.retryable,
		});
	}
	if (input.status !== "completed") {
		throw new Error("Invalid mailbox plans CLI terminal");
	}
	if (operation === "list") {
		return Object.freeze({
			schemaVersion: 1,
			type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
			requestAlias: input.requestAlias,
			operation,
			status: "completed",
			result: plansListResult(input.result),
		});
	}
	return Object.freeze({
		schemaVersion: 1,
		type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
		requestAlias: input.requestAlias,
		operation,
		status: "completed",
		result: plansActionResult(
			input.result,
			operation,
			input.requestAlias,
		),
	});
}

function safeTerminal(value: unknown): MailboxChatSubmitResult {
	const input = exact(
		value,
		(value as { status?: unknown })?.status === "canceled"
			? ["status"]
			: ["status", (value as { status?: unknown })?.status === "error"
					? "code"
					: "proposal"],
	);
	if (input.status === "canceled") return Object.freeze({ status: "canceled" });
	if (
		input.status === "error" &&
		typeof input.code === "string" &&
		MAILBOX_REASON_CODES.includes(input.code as MailboxReasonCode)
	) {
		return Object.freeze({
			status: "error",
			code: input.code as MailboxReasonCode,
		});
	}
	if (input.status === "proposal") {
		const proposal = validateMailboxPlanRevision(input.proposal);
		if (proposal.state === "draft") {
			return Object.freeze({ status: "proposal", proposal });
		}
	}
	throw new Error("Invalid mailbox CLI terminal result");
}

async function boundedResponseJson(response: Response): Promise<unknown> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (
		Number.isFinite(declared) &&
		declared > MAX_AUTHOR_RESULT_BYTES
	) {
		throw new Error("Mailbox CLI author result was too large");
	}
	if (response.body === null) {
		throw new Error("Mailbox CLI author result was empty");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_AUTHOR_RESULT_BYTES) {
			await reader.cancel();
			throw new Error("Mailbox CLI author result was too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function extensionTransportOrigin(value: string): string {
	if (!/^(?:chrome|moz)-extension:\/\/[a-z0-9-]+\/?$/.test(value)) {
		throw new Error("Invalid mailbox extension origin");
	}
	return value;
}

function plansHeaders(
	target: MailboxCliConnection,
	extensionOrigin: string,
): Readonly<Record<string, string>> {
	if (target.purpose !== "plans") {
		throw new Error("Invalid mailbox plans CLI connection");
	}
	return Object.freeze({
		authorization: `Bearer ${target.token}`,
		"content-type": "application/json",
		"x-dg-extension-origin": extensionTransportOrigin(extensionOrigin),
		"x-dg-mailbox-nonce": target.nonce,
	});
}

export async function requestMailboxPlansCliCommand(
	target: MailboxCliConnection,
	deps: Readonly<{
		extensionOrigin: string;
		fetch(input: string, init: RequestInit): Promise<Response>;
	}>,
): Promise<MailboxPlansCliRequest> {
	const response = await deps.fetch(
		`${target.origin}/mailbox-cleanup/v1/request/${target.runAlias}`,
		{
			method: "POST",
			headers: plansHeaders(target, deps.extensionOrigin),
			body: "{}",
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
			referrerPolicy: "no-referrer",
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (response.status !== 200) {
		throw new Error("Mailbox plans CLI request failed");
	}
	return validateMailboxPlansCliRequest(await boundedResponseJson(response));
}

/**
 * Abort a running plans action when its authenticated CLI loopback disappears.
 * Polling is deliberately bounded; disposal stops the monitor without
 * canceling an action that already produced its result.
 */
export function monitorMailboxPlansCliSession(
	target: MailboxCliConnection,
	deps: Readonly<{
		extensionOrigin: string;
		fetch(input: string, init: RequestInit): Promise<Response>;
	}>,
	options: Readonly<{
		intervalMs?: number;
		requestTimeoutMs?: number;
		maxDurationMs?: number;
	}> = {},
): MailboxPlansCliSessionMonitor {
	const intervalMs =
		options.intervalMs ?? DEFAULT_PLANS_MONITOR_INTERVAL_MS;
	const requestTimeoutMs =
		options.requestTimeoutMs ??
		DEFAULT_PLANS_MONITOR_REQUEST_TIMEOUT_MS;
	const maxDurationMs =
		options.maxDurationMs ?? DEFAULT_PLANS_MONITOR_MAX_DURATION_MS;
	if (
		!Number.isSafeInteger(intervalMs) ||
		intervalMs < 10 ||
		intervalMs > 1_000 ||
		!Number.isSafeInteger(requestTimeoutMs) ||
		requestTimeoutMs < 50 ||
		requestTimeoutMs > 30_000 ||
		!Number.isSafeInteger(maxDurationMs) ||
		maxDurationMs < 100 ||
		maxDurationMs > DEFAULT_PLANS_MONITOR_MAX_DURATION_MS
	) {
		throw new Error("Invalid mailbox plans CLI monitor");
	}
	const controller = new AbortController();
	let stopped = false;
	let nextPoll: ReturnType<typeof setTimeout> | undefined;
	let activePoll: AbortController | undefined;
	let activePollTimeout: ReturnType<typeof setTimeout> | undefined;
	const maximum = setTimeout(() => controller.abort(), maxDurationMs);
	const stopPolling = (): void => {
		if (nextPoll !== undefined) clearTimeout(nextPoll);
		if (activePollTimeout !== undefined) clearTimeout(activePollTimeout);
		activePoll?.abort();
		nextPoll = undefined;
		activePollTimeout = undefined;
		activePoll = undefined;
	};
	const onAbort = (): void => {
		clearTimeout(maximum);
		stopPolling();
	};
	controller.signal.addEventListener("abort", onAbort, { once: true });
	const poll = async (): Promise<void> => {
		if (stopped || controller.signal.aborted) return;
		const pollController = new AbortController();
		activePoll = pollController;
		activePollTimeout = setTimeout(
			() => pollController.abort(),
			requestTimeoutMs,
		);
		try {
			const response = await deps.fetch(
				`${target.origin}/mailbox-cleanup/v1/status/${target.runAlias}`,
				{
					method: "POST",
					headers: plansHeaders(target, deps.extensionOrigin),
					body: "{}",
					cache: "no-store",
					credentials: "omit",
					redirect: "error",
					referrerPolicy: "no-referrer",
					signal: pollController.signal,
				},
			);
			if (response.status !== 204) {
				throw new Error("Mailbox plans CLI session ended");
			}
		} catch {
			if (!stopped) controller.abort();
			return;
		} finally {
			if (activePoll === pollController) {
				if (activePollTimeout !== undefined) {
					clearTimeout(activePollTimeout);
				}
				activePoll = undefined;
				activePollTimeout = undefined;
			}
		}
		if (stopped || controller.signal.aborted) return;
		nextPoll = setTimeout(() => {
			nextPoll = undefined;
			void poll();
		}, intervalMs);
	};
	void poll();
	return Object.freeze({
		signal: controller.signal,
		dispose() {
			if (stopped) return;
			stopped = true;
			clearTimeout(maximum);
			controller.signal.removeEventListener("abort", onAbort);
			stopPolling();
		},
	});
}

export async function postMailboxPlansCliTerminal(
	target: MailboxCliConnection,
	value: unknown,
	deps: Readonly<{
		extensionOrigin: string;
		fetch(input: string, init: RequestInit): Promise<Response>;
	}>,
): Promise<void> {
	const terminal = validateMailboxPlansCliTerminal(value);
	const response = await deps.fetch(
		`${target.origin}/mailbox-cleanup/v1/result/${target.runAlias}`,
		{
			method: "POST",
			headers: plansHeaders(target, deps.extensionOrigin),
			body: JSON.stringify(terminal),
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
			referrerPolicy: "no-referrer",
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (response.status !== 204) {
		throw new Error("Mailbox plans CLI terminal delivery failed");
	}
}

export async function requestMailboxCliAuthor(
	target: MailboxCliConnection,
	message: MailboxChatSubmitMessage,
	deps: Readonly<{
		extensionOrigin: string;
		fetch(input: string, init: RequestInit): Promise<Response>;
	}>,
): Promise<MailboxChatSubmitResult> {
	if (
		message.type !== "mailbox_chat_submit" ||
		!NONCE.test(message.nonce) ||
		!/^act_[a-f0-9]{32}$/.test(message.requestAlias) ||
		!/^plan_[a-f0-9]{32}$/.test(message.planAlias)
	) {
		throw new Error("Invalid mailbox CLI author request");
	}
	if (!/^(?:chrome|moz)-extension:\/\/[a-z0-9-]+\/?$/.test(
		deps.extensionOrigin,
	)) {
		throw new Error("Invalid mailbox extension origin");
	}
	const response = await deps.fetch(
		`${target.origin}/mailbox-cleanup/v1/author/${target.runAlias}`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${target.token}`,
				"content-type": "application/json",
				"x-dg-extension-origin": deps.extensionOrigin,
				"x-dg-mailbox-nonce": target.nonce,
				"x-dg-mailbox-request": `${message.requestAlias}:${message.nonce}`,
			},
			body: JSON.stringify(message),
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
			referrerPolicy: "no-referrer",
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (response.status !== 200) {
		throw new Error("Mailbox CLI author request failed");
	}
	const result = safeTerminal(await boundedResponseJson(response));
	if (
		result.status === "proposal" &&
		result.proposal.planAlias !== message.planAlias
	) {
		throw new Error("Mailbox CLI author result scope mismatch");
	}
	return result;
}

export async function postMailboxCliTerminal(
	target: MailboxCliConnection,
	value: unknown,
	deps: Readonly<{
		extensionOrigin: string;
		fetch(input: string, init: RequestInit): Promise<Response>;
	}>,
): Promise<void> {
	const terminal = safeTerminal(value);
	if (!/^(?:chrome|moz)-extension:\/\/[a-z0-9-]+\/?$/.test(
		deps.extensionOrigin,
	)) {
		throw new Error("Invalid mailbox extension origin");
	}
	const response = await deps.fetch(
		`${target.origin}/mailbox-cleanup/v1/result/${target.runAlias}`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${target.token}`,
				"content-type": "application/json",
				"x-dg-extension-origin": deps.extensionOrigin,
				"x-dg-mailbox-nonce": target.nonce,
			},
			body: JSON.stringify(terminal),
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
			referrerPolicy: "no-referrer",
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (response.status !== 204) {
		throw new Error("Mailbox CLI terminal delivery failed");
	}
}
