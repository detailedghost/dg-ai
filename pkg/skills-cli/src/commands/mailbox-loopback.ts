import { randomBytes } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import {
	MAILBOX_REASON_CODES,
	validateMailboxInventory,
	validateMailboxPlanRevision,
	type MailboxPlanRevision,
} from "@dg/common";
import type {
	MailboxChatSubmitMessage,
	MailboxChatSubmitResult,
} from "../../../extension/lib/features/mailbox-cleanup/bridge/contracts";
import { tryOpen } from "../utils/lib";

const LOOPBACK_HOST = "127.0.0.1";
const CONNECT_PREFIX = "/mailbox-cleanup/v1/connect/";
const RESULT_PREFIX = "/mailbox-cleanup/v1/result/";
const AUTHOR_PREFIX = "/mailbox-cleanup/v1/author/";
const MARKER_KEY = "_dg_mailbox_cli";
const MAX_RESULT_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const EXTENSION_ORIGIN = /^(?:chrome|moz)-extension:\/\/[a-z0-9-]+\/?$/;
const RUN_ALIAS = /^run_[a-f0-9]{32}$/;
const NONCE = /^[a-f0-9]{32}$/;
const PLAN_ALIAS = /^plan_[a-f0-9]{32}$/;
const REQUEST_ALIAS = /^act_[a-f0-9]{32}$/;

type LoopbackDeps = Readonly<{
	open(url: string): Promise<boolean>;
	randomBytes(size: number): Uint8Array;
	timeoutMs: number;
	author(message: MailboxChatSubmitMessage): Promise<MailboxPlanRevision>;
}>;

export type MailboxCleanupLoopbackOptions =
	Partial<Omit<LoopbackDeps, "author">> &
	Readonly<{
		author?(message: MailboxChatSubmitMessage): Promise<MailboxPlanRevision>;
		readAuthorLine?(): Promise<string>;
		writeAuthorLine?(line: string): void;
	}>;

function exactRecord(value: unknown): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	) {
		throw new Error("Mailbox cleanup extension returned an invalid result");
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
): void {
	if (
		Object.keys(value).length !== required.length ||
		required.some((key) => !Object.hasOwn(value, key))
	) {
		throw new Error("Mailbox cleanup extension returned an invalid result");
	}
}

function terminalResult(value: unknown): MailboxChatSubmitResult {
	const input = exactRecord(value);
	if (input.status === "canceled") {
		exactKeys(input, ["status"]);
		return Object.freeze({ status: "canceled" });
	}
	if (input.status === "error") {
		exactKeys(input, ["status", "code"]);
		if (
			typeof input.code !== "string" ||
			!MAILBOX_REASON_CODES.includes(
				input.code as (typeof MAILBOX_REASON_CODES)[number],
			)
		) {
			throw new Error("Mailbox cleanup extension returned an invalid result");
		}
		return Object.freeze({
			status: "error",
			code: input.code as (typeof MAILBOX_REASON_CODES)[number],
		});
	}
	if (input.status === "proposal") {
		exactKeys(input, ["status", "proposal"]);
		const proposal = validateMailboxPlanRevision(
			structuredClone(input.proposal),
		);
		if (proposal.state !== "draft") {
			throw new Error("Mailbox cleanup extension returned an invalid result");
		}
		return Object.freeze({ status: "proposal", proposal });
	}
	throw new Error("Mailbox cleanup extension returned an invalid result");
}

function submitMessage(value: unknown): MailboxChatSubmitMessage {
	const input = exactRecord(value);
	exactKeys(input, [
		"schemaVersion",
		"type",
		"planAlias",
		"requestAlias",
		"nonce",
		"inventory",
		"revision",
	]);
	if (
		input.schemaVersion !== 1 ||
		input.type !== "mailbox_chat_submit" ||
		typeof input.planAlias !== "string" ||
		!PLAN_ALIAS.test(input.planAlias) ||
		typeof input.requestAlias !== "string" ||
		!REQUEST_ALIAS.test(input.requestAlias) ||
		typeof input.nonce !== "string" ||
		!NONCE.test(input.nonce)
	) {
		throw new Error("Mailbox cleanup extension returned an invalid request");
	}
	const inventory = validateMailboxInventory(
		structuredClone(input.inventory),
	);
	const revision = validateMailboxPlanRevision(
		structuredClone(input.revision),
	);
	if (
		inventory.partial ||
		revision.state !== "draft" ||
		revision.planAlias !== input.planAlias
	) {
		throw new Error("Mailbox cleanup extension returned an invalid request");
	}
	return Object.freeze({
		schemaVersion: 1,
		type: "mailbox_chat_submit",
		planAlias: input.planAlias,
		requestAlias: input.requestAlias,
		nonce: input.nonce,
		inventory,
		revision,
	});
}

function readStdinLine(timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		const timer = setTimeout(
			() => fail(),
			timeoutMs,
		);
		const cleanup = (): void => {
			clearTimeout(timer);
			process.stdin.off("data", onData);
			process.stdin.off("end", onEnd);
			process.stdin.off("error", onError);
			process.stdin.pause();
		};
		const fail = (): void => {
			cleanup();
			reject(new Error("Mailbox cleanup author input failed safely"));
		};
		const onError = (): void => fail();
		const onEnd = (): void => fail();
		const onData = (chunk: Buffer | string): void => {
			body += chunk.toString();
			if (Buffer.byteLength(body, "utf8") > MAX_RESULT_BYTES) {
				fail();
				return;
			}
			const newline = body.indexOf("\n");
			if (newline < 0) return;
			const line = body.slice(0, newline);
			if (body.slice(newline + 1).trim() !== "") {
				fail();
				return;
			}
			cleanup();
			resolve(line);
		};
		process.stdin.on("data", onData);
		process.stdin.once("end", onEnd);
		process.stdin.once("error", onError);
		process.stdin.resume();
	});
}

function jsonlAuthor(
	options: MailboxCleanupLoopbackOptions,
	runAlias: string,
	timeoutMs: number,
) {
	const read =
		options.readAuthorLine ??
		(() => readStdinLine(timeoutMs));
	const write =
		options.writeAuthorLine ??
		((line: string) => {
			process.stdout.write(line);
		});
	return async (
		message: MailboxChatSubmitMessage,
	): Promise<MailboxPlanRevision> => {
		write(
			`${JSON.stringify({
				schemaVersion: 1,
				type: "dg_mailbox_author_request",
				runAlias,
				planAlias: message.planAlias,
				requestAlias: message.requestAlias,
				nonce: message.nonce,
				inventory: message.inventory,
				revision: message.revision,
			})}\n`,
		);
		const input = exactRecord(JSON.parse(await read()) as unknown);
		exactKeys(input, [
			"schemaVersion",
			"type",
			"runAlias",
			"planAlias",
			"requestAlias",
			"nonce",
			"proposal",
		]);
		if (
			input.schemaVersion !== 1 ||
			input.type !== "dg_mailbox_author_proposal" ||
			input.runAlias !== runAlias ||
			input.planAlias !== message.planAlias ||
			input.requestAlias !== message.requestAlias ||
			input.nonce !== message.nonce
		) {
			throw new Error("Mailbox cleanup author input failed safely");
		}
		const proposal = validateMailboxPlanRevision(
			structuredClone(input.proposal),
		);
		if (
			proposal.state !== "draft" ||
			proposal.planAlias !== message.planAlias ||
			proposal.revisionAlias !== message.revision.revisionAlias ||
			proposal.revisionNumber !== message.revision.revisionNumber
		) {
			throw new Error("Mailbox cleanup author input failed safely");
		}
		return proposal;
	};
}

function hex(bytes: Uint8Array): string {
	return [...bytes]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.byteLength;
			if (size > MAX_RESULT_BYTES) {
				reject(new Error("Mailbox cleanup extension result was too large"));
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
				reject(new Error("Mailbox cleanup loopback failed safely"));
				return;
			}
			resolve(address.port);
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
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

/**
 * Open a one-shot authenticated rendezvous. The URL contains only an opaque
 * capability in its fragment; mailbox data never crosses argv, URL, or logs.
 */
export async function runMailboxCleanupLoopback(
	options: MailboxCleanupLoopbackOptions = {},
): Promise<MailboxChatSubmitResult> {
	const deps: Omit<LoopbackDeps, "author"> = {
		open: options.open ?? tryOpen,
		randomBytes: options.randomBytes ?? ((size) => randomBytes(size)),
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
	if (
		!Number.isSafeInteger(deps.timeoutMs) ||
		deps.timeoutMs < 100 ||
		deps.timeoutMs > 10 * 60_000
	) {
		throw new Error("Mailbox cleanup loopback timeout is invalid");
	}
	const runAlias = `run_${hex(deps.randomBytes(16))}`;
	const nonce = hex(deps.randomBytes(16));
	const token = hex(deps.randomBytes(32));
	if (!RUN_ALIAS.test(runAlias) || !NONCE.test(nonce) || token.length !== 64) {
		throw new Error("Mailbox cleanup loopback entropy unavailable");
	}
	const author =
		options.author ?? jsonlAuthor(options, runAlias, deps.timeoutMs);

	let settle!: (value: MailboxChatSubmitResult) => void;
	let reject!: (error: Error) => void;
	const terminal = new Promise<MailboxChatSubmitResult>((resolve, fail) => {
		settle = resolve;
		reject = fail;
	});
	// Observe early replies before Promise.race is installed after browser open.
	void terminal.catch(() => undefined);
	let terminalAccepted = false;
	let authorAccepted = false;
	const server = createServer(async (request, response) => {
		try {
			const requestUrl = new URL(
				request.url ?? "/",
				`http://${LOOPBACK_HOST}`,
			);
			const connectPath = `${CONNECT_PREFIX}${runAlias}`;
			const resultPath = `${RESULT_PREFIX}${runAlias}`;
			const authorPath = `${AUTHOR_PREFIX}${runAlias}`;
			if (request.method === "GET" && requestUrl.pathname === connectPath) {
				send(
					response,
					200,
					"<!doctype html><meta charset=utf-8><title>DeeGee mailbox cleanup</title><p>Connecting to the DeeGee extension…</p>",
					"text/html;charset=utf-8",
				);
				return;
			}
			if (
				request.method !== "POST" ||
				(requestUrl.pathname !== resultPath &&
					requestUrl.pathname !== authorPath)
			) {
				send(response, 404, "Not found");
				return;
			}
			if (
				terminalAccepted ||
				request.headers.authorization !== `Bearer ${token}` ||
				request.headers["x-dg-mailbox-nonce"] !== nonce ||
				typeof request.headers["x-dg-extension-origin"] !== "string" ||
				!EXTENSION_ORIGIN.test(
					request.headers["x-dg-extension-origin"],
				) ||
				!String(request.headers["content-type"] ?? "").startsWith(
					"application/json",
				)
			) {
				send(response, 403, "Forbidden");
				return;
			}
			const parsed = JSON.parse(await readBody(request)) as unknown;
			if (requestUrl.pathname === resultPath) {
				const result = terminalResult(parsed);
				terminalAccepted = true;
				send(response, 204, "");
				settle(result);
				return;
			}
			const message = submitMessage(parsed);
			if (
				authorAccepted ||
				request.headers["x-dg-mailbox-request"] !==
					`${message.requestAlias}:${message.nonce}`
			) {
				send(response, 403, "Forbidden");
				return;
			}
			authorAccepted = true;
			const proposal = await author(message);
			const result = terminalResult({
				status: "proposal",
				proposal,
			});
			terminalAccepted = true;
			send(
				response,
				200,
				JSON.stringify(result),
				"application/json;charset=utf-8",
			);
			settle(result);
		} catch {
			send(response, 400, "Invalid result");
			reject(new Error("Mailbox cleanup extension failed safely"));
		}
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
		}),
	).toString("base64url");
	const url = `${origin}${CONNECT_PREFIX}${runAlias}#${MARKER_KEY}=${marker}`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		let opened: boolean;
		try {
			opened = await deps.open(url);
		} catch {
			throw new Error("Mailbox cleanup extension failed safely");
		}
		if (!opened) {
			throw new Error(
				"Mailbox cleanup could not open the browser extension rendezvous",
			);
		}
		const timedOut = new Promise<never>((_, fail) => {
			timer = setTimeout(
				() =>
					fail(
						new Error(
							"Mailbox cleanup timed out waiting for the browser extension",
						),
					),
				deps.timeoutMs,
			);
		});
		return await Promise.race([terminal, timedOut]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		await close(server);
	}
}
