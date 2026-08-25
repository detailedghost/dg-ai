import { randomUUID } from "node:crypto";
import {
	ASSET_FILENAME_HEADER,
	AssetTooLargeError,
	CHAT_ASSETS_PATH,
	CHAT_CLI_PATH,
	CHAT_HEALTH_PATH,
	CHAT_LEGACY_HEALTH_PATH,
	CHAT_MAX_ASSET_BYTES,
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	CHAT_START_PATH,
	CHAT_STATUS_PATH,
	CHAT_WS_PATH,
	CLI_SESSION_ID_HEADER,
	CLI_SESSION_TOKEN_HEADER,
	describeError,
	type SessionRole,
} from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import type { Server } from "bun";
import { installAssetLifecycle } from "../assets/cleanup";
import {
	assetContentDisposition,
	resolveAssetContentType,
} from "../assets/content-type";
import { registerAsset } from "../assets/register";
import { assertFlatSegment } from "../assets/safe-path";
import { type AssetServeResult, resolveAssetForServing } from "../assets/serve";
import { DispatchScheduler } from "../dispatch";
import type { SessionRegistry } from "../session/registry";
import type { ChatStore } from "../store";
import {
	abortPendingWork,
	type ConnectionManager,
	createSocketState,
	resolveDrainWaiters,
	type SocketState,
} from "./connection";
import { handleSocketMessage } from "./frame-handlers";
import { isLoopbackHost } from "./host-guard";
import type { Logger } from "./log";
import {
	checkPinnedOrigin,
	isBrowserOrigin,
	isExtensionOrigin,
} from "./origin";
import { renderStatus, type StatusDeps } from "./status";

const ASSET_TOO_LARGE_MESSAGE = "refused: asset exceeds CHAT_MAX_ASSET_BYTES";

export type HttpServerDeps = {
	port: number;
	instanceId: string;
	paths: DgPaths;
	registry: SessionRegistry;
	connections: ConnectionManager;
	logger: Logger;
	noteActivity: () => void;
	statusDeps: Omit<StatusDeps, "instanceId" | "boundPort" | "registry">;
	store: ChatStore;
};

const NOSNIFF_HEADERS = { "X-Content-Type-Options": "nosniff" };

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			...NOSNIFF_HEADERS,
			...init.headers,
		},
	});
}

function requireLoopbackHost(req: Request, port: number): Response | undefined {
	if (isLoopbackHost(req.headers.get("host"), port)) return undefined;
	return new Response("refused: Host header is not the loopback authority", {
		status: 400,
	});
}

function bootstrapPageHtml(): string {
	return "<!doctype html><html><head><title>dg chat</title></head><body><p>Starting chat session…</p></body></html>";
}

function handleHealthCheck(
	req: Request,
	port: number,
	instanceId: string,
): Response {
	const failsHostOrOrigin =
		!isLoopbackHost(req.headers.get("host"), port) ||
		isBrowserOrigin(req.headers.get("origin"));
	if (failsHostOrOrigin) {
		return new Response(null, { status: 204 });
	}
	return json({
		daemon: "dg-daemon",
		protocolVersion: CHAT_PROTOCOL_VERSION,
		instanceId,
	});
}

export function createHttpServer(deps: HttpServerDeps): Server<SocketState> {
	const { port, paths, registry, connections, logger, noteActivity, store } =
		deps;

	const dispatchScheduler = new DispatchScheduler();
	const frameDeps = {
		registry,
		connections,
		logger,
		paths,
		noteActivity,
		store,
		dispatchScheduler,
	};

	const boundServer = Bun.serve<SocketState>({
		hostname: "127.0.0.1",
		port,
		reusePort: false,
		idleTimeout: 255,
		maxRequestBodySize: CHAT_MAX_ASSET_BYTES,
		development: false,
		error(err) {
			logger.error(`unhandled request error: ${describeError(err)}`);
			return new Response("internal error", {
				status: 500,
				headers: {
					"Content-Type": "text/plain; charset=utf-8",
					...NOSNIFF_HEADERS,
				},
			});
		},
		websocket: {
			idleTimeout: 120,
			sendPings: true,
			maxPayloadLength: CHAT_MAX_PAYLOAD_BYTES + 4096,
			open(ws) {
				connections.add(ws);
				noteActivity();
			},
			message(ws, message) {
				handleSocketMessage(ws, message, frameDeps).catch((err: unknown) => {
					frameDeps.logger.error(
						`frame handling failed: ${describeError(err)}`,
					);
					ws.close(1011, "internal error");
				});
			},
			close(ws) {
				resolveDrainWaiters(ws);
				abortPendingWork(ws);
				connections.remove(ws);
				noteActivity();
			},
			drain(ws) {
				resolveDrainWaiters(ws);
			},
		},
		fetch(req, server) {
			const url = new URL(req.url);

			const isHealth =
				url.pathname === CHAT_HEALTH_PATH ||
				url.pathname === CHAT_LEGACY_HEALTH_PATH;
			if (isHealth) {
				return handleHealthCheck(req, port, deps.instanceId);
			}

			const hostError = requireLoopbackHost(req, port);
			if (hostError) return hostError;

			if (url.pathname === CHAT_STATUS_PATH && req.method === "GET") {
				return json(
					renderStatus({
						...deps.statusDeps,
						instanceId: deps.instanceId,
						boundPort: port,
						registry,
					}),
				);
			}

			if (url.pathname === CHAT_START_PATH && req.method === "GET") {
				return new Response(bootstrapPageHtml(), {
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						...NOSNIFF_HEADERS,
					},
				});
			}

			if (url.pathname === CHAT_START_PATH && req.method === "POST") {
				return handleRegisterSession(req, deps);
			}

			if (url.pathname === CHAT_WS_PATH) {
				return handleWsUpgrade(req, server, deps);
			}

			if (url.pathname === CHAT_CLI_PATH) {
				return handleCliUpgrade(req, server, deps);
			}

			if (url.pathname === CHAT_ASSETS_PATH && req.method === "POST") {
				return handleAssetPost(req, deps);
			}

			if (
				url.pathname.startsWith(`${CHAT_ASSETS_PATH}/`) &&
				req.method === "GET"
			) {
				return handleAssetGet(req, url, deps);
			}

			return new Response("not found", { status: 404 });
		},
	});

	installAssetLifecycle(paths, store, logger, port);
	return boundServer;
}

async function handleRegisterSession(
	req: Request,
	deps: HttpServerDeps,
): Promise<Response> {
	if (isBrowserOrigin(req.headers.get("origin"))) {
		return new Response("refused: /start rejects a browser Origin", {
			status: 400,
		});
	}
	const contentType = (req.headers.get("content-type") ?? "")
		.split(";")[0]
		.trim();
	if (contentType !== "application/json") {
		return new Response("Content-Type must be application/json", {
			status: 415,
		});
	}

	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return new Response("invalid JSON body", { status: 400 });
	}
	if (typeof body !== "object" || body === null) {
		return new Response("body must be an object", { status: 400 });
	}
	const input = body as Record<string, unknown>;
	if (typeof input.cwd !== "string" || input.cwd.trim().length === 0) {
		return new Response("cwd is required", { status: 400 });
	}
	const role: SessionRole =
		input.role === "orchestrator" ? "orchestrator" : "agent";
	const workset =
		typeof input.workset === "string"
			? input.workset.trim() || undefined
			: undefined;
	const agentIdentity =
		typeof input.agentIdentity === "string" &&
		input.agentIdentity.trim().length > 0
			? input.agentIdentity.trim()
			: "agent";

	let record: ReturnType<typeof deps.registry.create>;
	try {
		record = deps.registry.create({
			cwd: input.cwd,
			agentIdentity,
			workset,
			role,
		});
	} catch {
		return new Response(`cwd does not resolve: ${input.cwd}`, { status: 400 });
	}
	deps.noteActivity();

	return json({
		port: deps.port,
		sessionId: record.sessionId,
		token: record.token,
		agentIdentity: record.agentIdentity,
	});
}

function handleWsUpgrade(
	req: Request,
	server: Server<SocketState>,
	deps: HttpServerDeps,
): Response {
	const origin = req.headers.get("origin");
	if (!isExtensionOrigin(origin)) {
		return new Response("refused: /ws requires an extension-scheme Origin", {
			status: 400,
		});
	}
	if (!checkPinnedOrigin(deps.paths, origin as string)) {
		return new Response(
			"refused: Origin does not match the pinned extension origin",
			{
				status: 400,
			},
		);
	}
	const data = createSocketState("ws", deps.logger, origin as string);
	const upgraded = server.upgrade(req, { data });
	if (!upgraded) return new Response("upgrade failed", { status: 500 });
	return new Response(null, { status: 101 });
}

function requireSessionCredentials(
	req: Request,
	registry: SessionRegistry,
): { sessionId: string; token: string } | Response {
	const sessionId = req.headers.get(CLI_SESSION_ID_HEADER);
	const token = req.headers.get(CLI_SESSION_TOKEN_HEADER);
	if (!sessionId || !token || !registry.validate(sessionId, token)) {
		return new Response("refused: invalid or unknown session capability", {
			status: 401,
			headers: NOSNIFF_HEADERS,
		});
	}
	return { sessionId, token };
}

function handleCliUpgrade(
	req: Request,
	server: Server<SocketState>,
	deps: HttpServerDeps,
): Response {
	const origin = req.headers.get("origin");
	if (isBrowserOrigin(origin)) {
		return new Response("refused: /cli rejects a browser Origin", {
			status: 400,
		});
	}
	const credentials = requireSessionCredentials(req, deps.registry);
	if (credentials instanceof Response) return credentials;
	const data = createSocketState("cli", deps.logger);
	data.capabilities.set(credentials.sessionId, credentials.token);
	const upgraded = server.upgrade(req, { data });
	if (!upgraded) return new Response("upgrade failed", { status: 500 });
	return new Response(null, { status: 101 });
}

function isPlainAssetFilename(filename: string): boolean {
	try {
		assertFlatSegment(filename);
		return true;
	} catch {
		return false;
	}
}

/** Buffers the body, abandoning it the moment it passes the cap; undefined means it did. */
export async function readCappedBody(
	req: Request,
	capBytes: number,
): Promise<Buffer | undefined> {
	if (!req.body) return Buffer.alloc(0);
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > capBytes) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

async function handleAssetPost(
	req: Request,
	deps: HttpServerDeps,
): Promise<Response> {
	if (isBrowserOrigin(req.headers.get("origin"))) {
		return new Response("refused: /assets rejects a browser Origin", {
			status: 400,
			headers: NOSNIFF_HEADERS,
		});
	}

	const credentials = requireSessionCredentials(req, deps.registry);
	if (credentials instanceof Response) return credentials;
	const { sessionId } = credentials;

	const rawFilename = req.headers.get(ASSET_FILENAME_HEADER);
	if (!rawFilename) {
		return new Response(`refused: ${ASSET_FILENAME_HEADER} is required`, {
			status: 400,
			headers: NOSNIFF_HEADERS,
		});
	}
	let filename: string;
	try {
		filename = decodeURIComponent(rawFilename);
	} catch {
		return new Response(
			`refused: ${ASSET_FILENAME_HEADER} is not valid percent-encoding`,
			{ status: 400, headers: NOSNIFF_HEADERS },
		);
	}
	if (!isPlainAssetFilename(filename)) {
		return new Response(
			`refused: ${ASSET_FILENAME_HEADER} must be a plain basename`,
			{ status: 400, headers: NOSNIFF_HEADERS },
		);
	}

	const bytes = await readCappedBody(req, CHAT_MAX_ASSET_BYTES);
	if (!bytes) {
		return new Response(ASSET_TOO_LARGE_MESSAGE, {
			status: 413,
			headers: NOSNIFF_HEADERS,
		});
	}

	const id = randomUUID();
	try {
		await registerAsset(
			{ paths: deps.paths, store: deps.store },
			{
				sessionId,
				id,
				filename,
				contentType: resolveAssetContentType(filename).contentType,
				bytes,
			},
		);
	} catch (err) {
		if (err instanceof AssetTooLargeError) {
			return new Response(ASSET_TOO_LARGE_MESSAGE, {
				status: 413,
				headers: NOSNIFF_HEADERS,
			});
		}
		deps.logger.error(
			`asset upload failed: ${err instanceof Error ? err.name : "unknown error"}`,
		);
		return new Response("failed to register asset", {
			status: 500,
			headers: NOSNIFF_HEADERS,
		});
	}

	deps.noteActivity();
	return json({ assetId: id });
}

type AssetErrorStatus = Exclude<AssetServeResult["status"], "ok">;

const ASSET_ERROR_RESPONSES: Record<
	AssetErrorStatus,
	{ status: number; message: string }
> = {
	unauthorized: { status: 401, message: "refused: invalid session capability" },
	"session-closed": {
		status: 404,
		message: "asset not found: session closed",
	},
	unknown: { status: 404, message: "asset not found: unknown" },
	pruned: { status: 404, message: "asset not found: pruned" },
	"missing-file": {
		status: 404,
		message: "asset not found: staged bytes are gone",
	},
	"unsafe-path": { status: 500, message: "refused: asset path is unsafe" },
	"too-large": {
		status: 500,
		message: "refused: staged asset exceeds the maximum size",
	},
	corrupt: {
		status: 500,
		message: "refused: staged asset failed integrity checks",
	},
};

async function handleAssetGet(
	req: Request,
	url: URL,
	deps: HttpServerDeps,
): Promise<Response> {
	const sessionId = req.headers.get(CLI_SESSION_ID_HEADER);
	const token = req.headers.get(CLI_SESSION_TOKEN_HEADER);
	if (!sessionId || !token) {
		return new Response("refused: missing session credentials", {
			status: 401,
			headers: NOSNIFF_HEADERS,
		});
	}
	let id: string;
	try {
		id = decodeURIComponent(url.pathname.slice(`${CHAT_ASSETS_PATH}/`.length));
	} catch {
		return new Response("refused: asset id is not valid percent-encoding", {
			status: 400,
			headers: NOSNIFF_HEADERS,
		});
	}

	const result = await resolveAssetForServing(
		{ paths: deps.paths, store: deps.store, registry: deps.registry },
		{ sessionId, token, id },
	);

	if (result.status === "ok") {
		const disposition = assetContentDisposition(
			{ contentType: result.contentType, inline: result.inline },
			result.filename,
		);
		const body = new Uint8Array(
			result.bytes.buffer as ArrayBuffer,
			result.bytes.byteOffset,
			result.bytes.byteLength,
		);
		return new Response(body, {
			status: 200,
			headers: {
				"Content-Type": result.contentType,
				"Content-Disposition": disposition,
				...NOSNIFF_HEADERS,
			},
		});
	}

	const { status, message } = ASSET_ERROR_RESPONSES[result.status];
	return new Response(message, { status, headers: NOSNIFF_HEADERS });
}

export function newInstanceId(): string {
	return randomUUID();
}
