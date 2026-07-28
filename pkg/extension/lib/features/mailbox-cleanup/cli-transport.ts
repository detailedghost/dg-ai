import {
	MAILBOX_REASON_CODES,
	validateMailboxPlanRevision,
	type MailboxReasonCode,
} from "@dg/common";
import type {
	MailboxChatSubmitMessage,
	MailboxChatSubmitResult,
} from "./bridge";

export const MAILBOX_CLI_CONNECT_TYPE =
	"dg-mailbox-cleanup:cli-connect" as const;
export const MAILBOX_CLI_APPROVAL_INSPECT_TYPE =
	"dg-mailbox-cleanup:cli-approval-inspect" as const;
export const MAILBOX_CLI_APPROVAL_DECISION_TYPE =
	"dg-mailbox-cleanup:cli-approval-decision" as const;
export const MAILBOX_CLI_MARKER_KEY = "_dg_mailbox_cli";
const RUN_ALIAS = /^run_[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const APPROVAL_ALIAS = /^cli_[a-f0-9]{32}$/;
const MAX_MARKER_LENGTH = 2_048;
const MAX_AUTHOR_RESULT_BYTES = 2_000_000;

export type MailboxCliConnection = Readonly<{
	schemaVersion: 1;
	origin: string;
	runAlias: string;
	nonce: string;
	token: string;
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
	if (
		Object.keys(input).length !== required.length ||
		required.some((key) => !Object.hasOwn(input, key))
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
	const input = exact(value, [
		"schemaVersion",
		"origin",
		"runAlias",
		"nonce",
		"token",
	]);
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
