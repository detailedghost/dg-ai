import { randomBytes } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import type { Command } from "commander";
import {
	MAILBOX_PLAN_LIST_STATES,
	type MailboxPlanListCommandType,
	type MailboxPlanListState,
} from "../../../extension/lib/features/mailbox-cleanup/plan-workspace/list";
import {
	MAILBOX_CLI_MARKER_KEY,
	MAILBOX_PLANS_CLI_REQUEST_TYPE,
	MAILBOX_PLANS_CLI_TERMINAL_TYPE,
	validateMailboxPlansCliRequest,
	validateMailboxPlansCliTerminal,
	type MailboxPlansCliRequest,
	type MailboxPlansCliTerminal,
} from "../../../extension/lib/features/mailbox-cleanup/cli-transport";
import { tryOpen } from "../utils/lib";

const LOOPBACK_HOST = "127.0.0.1";
const CONNECT_PREFIX = "/mailbox-cleanup/v1/connect/";
const REQUEST_PREFIX = "/mailbox-cleanup/v1/request/";
const RESULT_PREFIX = "/mailbox-cleanup/v1/result/";
const STATUS_PREFIX = "/mailbox-cleanup/v1/status/";
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 2_000_000;
const RUN_ALIAS = /^run_[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const REQUEST_ALIAS = /^req_[a-f0-9]{32}$/;
const PLAN_ALIAS = /^plan_[a-f0-9]{32}$/;
const REVISION_ALIAS = /^rev_[a-f0-9]{32}$/;
const EXTENSION_ORIGIN = /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+\/?$/;

export const MAILBOX_PLANS_EXIT_CODES = Object.freeze({
	success: 0,
	failure: 1,
	canceled: 2,
	timeout: 3,
	blocked: 4,
} as const);

export type MailboxPlansRunner = (
	request: MailboxPlansCliRequest,
	options?: MailboxPlansLoopbackOptions,
) => Promise<MailboxPlansCliTerminal>;

export type MailboxPlansIo = Readonly<{
	writeStdout(value: string): void;
	setExitCode(value: number): void;
}>;

export type MailboxPlansLoopbackOptions = Readonly<{
	open?(url: string): Promise<boolean>;
	randomBytes?(size: number): Uint8Array;
	timeoutMs?: number;
	signal?: AbortSignal;
}>;

function hex(bytes: Uint8Array): string {
	return [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function entropy(
	size: number,
	random: (size: number) => Uint8Array,
	pattern: RegExp,
	prefix = "",
): string {
	const bytes = random(size);
	if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
		throw new Error("Mailbox plans entropy unavailable");
	}
	const value = `${prefix}${hex(bytes)}`;
	if (!pattern.test(value)) {
		throw new Error("Mailbox plans entropy unavailable");
	}
	return value;
}

function exactEmpty(value: unknown): void {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.keys(value).length !== 0
	) {
		throw new Error("Mailbox plans request was invalid");
	}
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Mailbox plans response was too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () =>
			resolve(Buffer.concat(chunks).toString("utf8")),
		);
		request.on("error", reject);
	});
}

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, LOOPBACK_HOST, () => {
			server.off("error", reject);
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(new Error("Mailbox plans loopback failed safely"));
				return;
			}
			resolve(address.port);
		});
	});
}

function close(
	server: Server,
	sockets: ReadonlySet<Socket>,
	requests: ReadonlySet<IncomingMessage>,
	responses: ReadonlySet<ServerResponse>,
): Promise<void> {
	return new Promise((resolve) => {
		for (const response of responses) {
			response.destroy();
		}
		for (const request of requests) request.destroy();
		if (!server.listening) {
			for (const socket of sockets) {
				socket.destroy(new Error("Mailbox plans loopback closed"));
			}
			resolve();
			return;
		}
		server.close(() => resolve());
		server.closeAllConnections?.();
		for (const socket of sockets) {
			socket.destroy(new Error("Mailbox plans loopback closed"));
		}
	});
}

function send(
	response: ServerResponse,
	status: number,
	body: string,
	contentType = "text/plain;charset=utf-8",
): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
		"content-type": contentType,
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
	});
	response.end(body);
}

function errorTerminal(
	request: MailboxPlansCliRequest,
	code:
		| "provider_timeout"
		| "provider_refused"
		| "internal_failure",
	retryable: boolean,
): MailboxPlansCliTerminal {
	return Object.freeze({
		schemaVersion: 1,
		type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
		requestAlias: request.requestAlias,
		operation: request.operation,
		status: "error",
		code,
		retryable,
	});
}

function canceledTerminal(
	request: MailboxPlansCliRequest,
): MailboxPlansCliTerminal {
	return Object.freeze({
		schemaVersion: 1,
		type: MAILBOX_PLANS_CLI_TERMINAL_TYPE,
		requestAlias: request.requestAlias,
		operation: request.operation,
		status: "canceled",
	});
}

/**
 * Run one approved, authenticated plans request. Only opaque capabilities are
 * placed in the URL; the sanitized command is served from memory once.
 */
export async function runMailboxPlansLoopback(
	value: MailboxPlansCliRequest,
	options: MailboxPlansLoopbackOptions = {},
): Promise<MailboxPlansCliTerminal> {
	const request = validateMailboxPlansCliRequest(value);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < MIN_TIMEOUT_MS ||
		timeoutMs > MAX_TIMEOUT_MS
	) {
		throw new Error("Mailbox plans timeout is invalid");
	}
	const random =
		options.randomBytes ??
		((size: number) => randomBytes(size));
	const runAlias = entropy(16, random, RUN_ALIAS, "run_");
	const nonce = entropy(16, random, NONCE);
	const token = entropy(32, random, TOKEN);
	let settle!: (result: MailboxPlansCliTerminal) => void;
	const terminal = new Promise<MailboxPlansCliTerminal>((resolve) => {
		settle = resolve;
	});
	type Phase =
		| "awaiting_request"
		| "reading_request"
		| "awaiting_result"
		| "reading_result"
		| "terminal_accepted"
		| "settled";
	let phase: Phase = "awaiting_request";
	const sockets = new Set<Socket>();
	const activeIncoming = new Set<IncomingMessage>();
	const activeResponses = new Set<ServerResponse>();
	const server = createServer(async (incoming, response) => {
		activeIncoming.add(incoming);
		activeResponses.add(response);
		incoming.once("close", () => activeIncoming.delete(incoming));
		response.once("close", () => activeResponses.delete(response));
		try {
			const requestUrl = new URL(
				incoming.url ?? "/",
				`http://${LOOPBACK_HOST}`,
			);
			if (
				incoming.method === "GET" &&
				requestUrl.pathname === `${CONNECT_PREFIX}${runAlias}`
			) {
				send(
					response,
					200,
					"<!doctype html><meta charset=utf-8><title>DeeGee mailbox plans</title><p>Connecting to the DeeGee extension…</p>",
					"text/html;charset=utf-8",
				);
				return;
			}
				const isRequest =
					requestUrl.pathname === `${REQUEST_PREFIX}${runAlias}`;
				const isResult =
					requestUrl.pathname === `${RESULT_PREFIX}${runAlias}`;
				const isStatus =
					requestUrl.pathname === `${STATUS_PREFIX}${runAlias}`;
				if (
					incoming.method !== "POST" ||
					(!isRequest && !isResult && !isStatus)
				) {
					send(response, 404, "Not found");
					return;
				}
			if (
				incoming.headers.authorization !== `Bearer ${token}` ||
				incoming.headers["x-dg-mailbox-nonce"] !== nonce ||
				typeof incoming.headers["x-dg-extension-origin"] !== "string" ||
				!EXTENSION_ORIGIN.test(
					incoming.headers["x-dg-extension-origin"],
				) ||
				!String(incoming.headers["content-type"] ?? "").startsWith(
					"application/json",
				)
			) {
				send(response, 403, "Forbidden");
					return;
				}
				if (isStatus) {
					exactEmpty(JSON.parse(await readBody(incoming)) as unknown);
					if (
						phase !== "awaiting_result" &&
						phase !== "reading_result" &&
						phase !== "terminal_accepted"
					) {
						send(response, 409, "Inactive");
						return;
					}
					send(response, 204, "");
					return;
				}
				if (isRequest) {
					if (phase !== "awaiting_request") {
						send(response, 403, "Forbidden");
						return;
					}
					phase = "reading_request";
					try {
						exactEmpty(
							JSON.parse(await readBody(incoming)) as unknown,
						);
					} catch (error) {
						if (phase === "reading_request") {
							phase = "settled";
							settle(
								errorTerminal(
									request,
									"internal_failure",
									false,
								),
							);
						}
						throw error;
					}
					if (phase !== "reading_request") {
						send(response, 409, "Inactive");
						return;
					}
					phase = "awaiting_result";
					send(
						response,
					200,
					JSON.stringify(request),
					"application/json;charset=utf-8",
				);
					return;
				}
				if (phase !== "awaiting_result") {
					send(response, 403, "Forbidden");
					return;
				}
				phase = "reading_result";
				let result: MailboxPlansCliTerminal;
				try {
					result = validateMailboxPlansCliTerminal(
						JSON.parse(await readBody(incoming)) as unknown,
						request,
					);
				} catch (error) {
					if (phase === "reading_result") {
						phase = "settled";
						settle(
							errorTerminal(
								request,
								"internal_failure",
								false,
							),
						);
					}
					throw error;
				}
				if (phase !== "reading_result") {
					send(response, 409, "Inactive");
					return;
				}
				phase = "terminal_accepted";
				send(response, 204, "");
				settle(result);
			} catch {
				if (!response.destroyed && !response.writableEnded) {
					send(response, 400, "Invalid result");
				}
			}
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.once("close", () => sockets.delete(socket));
	});

	const port = await listen(server);
	const origin = `http://${LOOPBACK_HOST}:${port}`;
	const marker = Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			origin,
			runAlias,
			nonce,
			token,
			purpose: "plans",
		}),
	).toString("base64url");
	const url =
		`${origin}${CONNECT_PREFIX}${runAlias}` +
		`#${MAILBOX_CLI_MARKER_KEY}=${marker}`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const deadline = new Promise<MailboxPlansCliTerminal>((resolve) => {
			timer = setTimeout(
				() =>
					resolve(
						errorTerminal(
							request,
							"provider_timeout",
							true,
						),
					),
				timeoutMs,
			);
		});
		const canceled = new Promise<MailboxPlansCliTerminal>((resolve) => {
			onAbort = () => resolve(canceledTerminal(request));
			options.signal?.addEventListener("abort", onAbort, {
				once: true,
			});
			if (options.signal?.aborted) onAbort();
		});
		const opened = Promise.resolve()
			.then(() => (options.open ?? tryOpen)(url))
			.then(
				(success) =>
					Object.freeze({
						kind: "opened" as const,
						success,
					}),
				() =>
					Object.freeze({
						kind: "open_error" as const,
					}),
			);
		const opening = await Promise.race([
			opened,
			deadline,
			canceled,
		]);
		if (!("kind" in opening)) return opening;
		if (opening.kind === "open_error") {
			return errorTerminal(request, "internal_failure", false);
		}
		if (!opening.success) {
			return errorTerminal(request, "provider_refused", true);
		}
		return await Promise.race([terminal, deadline, canceled]);
	} catch {
		return errorTerminal(request, "internal_failure", false);
	} finally {
		phase = "settled";
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort !== undefined) {
			options.signal?.removeEventListener("abort", onAbort);
		}
		await close(server, sockets, activeIncoming, activeResponses);
	}
}

function requestAlias(): string {
	return entropy(16, (size) => randomBytes(size), REQUEST_ALIAS, "req_");
}

function timeout(value: string): number {
	const parsed = Number(value);
	if (
		!Number.isSafeInteger(parsed) ||
		parsed < MIN_TIMEOUT_MS ||
		parsed > MAX_TIMEOUT_MS
	) {
		throw new Error("Mailbox plans timeout is invalid");
	}
	return parsed;
}

function states(values: string[]): readonly MailboxPlanListState[] {
	if (
		values.length > MAILBOX_PLAN_LIST_STATES.length ||
		new Set(values).size !== values.length ||
		values.some(
			(value) =>
				!MAILBOX_PLAN_LIST_STATES.includes(
					value as MailboxPlanListState,
				),
		)
	) {
		throw new Error("Mailbox plans state filter is invalid");
	}
	return Object.freeze(
		values.length === 0
			? [...MAILBOX_PLAN_LIST_STATES]
			: (values as MailboxPlanListState[]),
	);
}

function aliases(planAlias: string, revisionAlias: string): void {
	if (!PLAN_ALIAS.test(planAlias) || !REVISION_ALIAS.test(revisionAlias)) {
		throw new Error("Mailbox plans scope is invalid");
	}
}

function exitCode(terminal: MailboxPlansCliTerminal): number {
	if (terminal.status === "canceled") {
		return MAILBOX_PLANS_EXIT_CODES.canceled;
	}
	if (terminal.status === "error") {
		return terminal.code === "provider_timeout"
			? MAILBOX_PLANS_EXIT_CODES.timeout
			: terminal.code === "internal_failure" ||
					terminal.code === "malformed_stream"
				? MAILBOX_PLANS_EXIT_CODES.failure
				: MAILBOX_PLANS_EXIT_CODES.blocked;
	}
	if (
		terminal.operation !== "list" &&
		terminal.result.status === "canceled"
	) {
		return MAILBOX_PLANS_EXIT_CODES.canceled;
	}
	if (
		terminal.operation !== "list" &&
		terminal.result.status === "blocked"
	) {
		return MAILBOX_PLANS_EXIT_CODES.blocked;
	}
	return MAILBOX_PLANS_EXIT_CODES.success;
}

function outputTerminal(
	request: MailboxPlansCliRequest,
	value: unknown,
	now = Date.now(),
): MailboxPlansCliTerminal {
	const terminal = validateMailboxPlansCliTerminal(value, request);
	if (
		terminal.status !== "completed" ||
		terminal.operation !== "list" ||
		request.operation !== "list"
	) {
		return terminal;
	}
	if (
		terminal.result.rows.some(
			(row) =>
				Date.parse(row.expiresAt) <= now ||
				!request.query.states?.includes(row.lifecycleState) ||
				(request.query.stale === "only" && !row.stale) ||
				(request.query.stale === "exclude" && row.stale) ||
				(request.query.providerId !== undefined &&
					row.providerId !== request.query.providerId) ||
				(request.query.surface !== undefined &&
					row.surface !== request.query.surface) ||
				(request.query.accountAlias !== undefined &&
					row.accountAlias !== request.query.accountAlias),
		)
	) {
		return errorTerminal(request, "internal_failure", false);
	}
	const rows = [...terminal.result.rows].sort(
		(left, right) =>
			right.updatedAt.localeCompare(left.updatedAt) ||
			left.planAlias.localeCompare(right.planAlias) ||
			left.revisionAlias.localeCompare(right.revisionAlias),
	);
	return Object.freeze({
		...terminal,
		result: Object.freeze({
			schemaVersion: 1,
			rows: Object.freeze(rows),
		}),
	});
}

export function registerMailboxPlans(
	program: Command,
	run: MailboxPlansRunner = runMailboxPlansLoopback,
	io: MailboxPlansIo = {
		writeStdout: (value) => process.stdout.write(value),
		setExitCode: (value) => {
			process.exitCode = value;
		},
	},
): void {
	const root = program
		.command("mailbox-plans")
		.description("list, open, resume, or restart sanitized mailbox plans");

	const execute = async (
		request: MailboxPlansCliRequest,
		timeoutMs: number,
	): Promise<void> => {
		const controller = new AbortController();
		const cancel = (): void => controller.abort();
		process.once("SIGINT", cancel);
		let terminal: MailboxPlansCliTerminal;
		try {
			terminal = outputTerminal(
				request,
				await run(request, {
					timeoutMs,
					signal: controller.signal,
				}),
			);
		} catch {
			terminal = errorTerminal(request, "internal_failure", false);
		} finally {
			process.off("SIGINT", cancel);
		}
		io.writeStdout(`${JSON.stringify(terminal)}\n`);
		io.setExitCode(exitCode(terminal));
	};

	root.action(async () => {
		const alias = requestAlias();
		await execute(
			validateMailboxPlansCliRequest({
				schemaVersion: 1,
				type: MAILBOX_PLANS_CLI_REQUEST_TYPE,
				requestAlias: alias,
				operation: "list",
				query: {
					states: [...MAILBOX_PLAN_LIST_STATES],
					stale: "all",
				},
			}),
			DEFAULT_TIMEOUT_MS,
		);
	});

	root
		.command("list")
		.description("list unexpired sanitized mailbox plans")
		.option(
			"--state <state>",
			"lifecycle state; repeat to include multiple states",
			(value: string, prior: string[]) => [...prior, value],
			[],
		)
		.option(
			"--stale <mode>",
			"stale filter: all, only, or exclude",
			"all",
		)
		.option("--provider <provider-id>", "filter by sanitized provider ID")
		.option("--surface <surface>", "filter by provider surface")
		.option("--account <account-alias>", "filter by sanitized account alias")
		.option(
			"--timeout <milliseconds>",
			"bounded wait for the extension",
			timeout,
			DEFAULT_TIMEOUT_MS,
		)
		.action(
			async (options: {
				state: string[];
				stale: string;
				provider?: string;
				surface?: string;
				account?: string;
				timeout: number;
			}) => {
				if (!["all", "only", "exclude"].includes(options.stale)) {
					throw new Error("Mailbox plans stale filter is invalid");
				}
				const alias = requestAlias();
				await execute(
					validateMailboxPlansCliRequest({
						schemaVersion: 1,
						type: MAILBOX_PLANS_CLI_REQUEST_TYPE,
						requestAlias: alias,
						operation: "list",
						query: {
							states: states(options.state),
							stale: options.stale,
							...(options.provider === undefined
								? {}
								: { providerId: options.provider }),
							...(options.surface === undefined
								? {}
								: { surface: options.surface }),
							...(options.account === undefined
								? {}
								: { accountAlias: options.account }),
						},
					}),
					options.timeout,
				);
			},
		);

	for (const operation of [
		"edit",
		"preflight",
		"focus",
		"resume",
		"restart",
	] as const) {
		root
			.command(operation)
			.description(`${operation} one sanitized mailbox plan`)
			.argument("<plan-alias>")
			.argument("<revision-alias>")
			.option(
				"--timeout <milliseconds>",
				"bounded wait for the extension",
				timeout,
				DEFAULT_TIMEOUT_MS,
			)
			.action(
				async (
					planAlias: string,
					revisionAlias: string,
					options: { timeout: number },
				) => {
					aliases(planAlias, revisionAlias);
					const alias = requestAlias();
					await execute(
						validateMailboxPlansCliRequest({
							schemaVersion: 1,
							type: MAILBOX_PLANS_CLI_REQUEST_TYPE,
							requestAlias: alias,
							operation,
							command: {
								schemaVersion: 1,
								type: operation,
								planAlias,
								revisionAlias,
								requestAlias: alias,
							},
						}),
						options.timeout,
					);
				},
			);
	}
}
