import { randomUUID } from "node:crypto";
import {
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	type SessionRole,
} from "@dg/common";
import type { DgPaths } from "@dg/common/node";
import type { Server } from "bun";
import { DispatchScheduler } from "../dispatch";
import type { SessionRegistry } from "../session/registry";
import type { ChatStore } from "../store";
import {
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

export const CLI_SESSION_ID_HEADER = "X-Dg-Session-Id";
export const CLI_SESSION_TOKEN_HEADER = "X-Dg-Session-Token";

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

function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { "Content-Type": "application/json", ...init.headers },
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

export function createHttpServer(deps: HttpServerDeps): Server<SocketState> {
	const { port, paths, registry, connections, logger, noteActivity, store } =
		deps;

	// One scheduler for the daemon's lifetime — concurrency/rate bounds are
	// meaningless if reset per connection.
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

	return Bun.serve<SocketState>({
		hostname: "127.0.0.1", // Bun defaults to 0.0.0.0 — never inherit that.
		port,
		reusePort: false, // NEVER true: would let two daemons load-balance the same port.
		idleTimeout: 255, // HTTP idleTimeout caps at 255s.
		websocket: {
			idleTimeout: 120,
			sendPings: true,
			maxPayloadLength: CHAT_MAX_PAYLOAD_BYTES + 4096, // headroom above our own graceful rejection boundary
			open(ws) {
				connections.add(ws);
				noteActivity();
			},
			message(ws, message) {
				void handleSocketMessage(ws, message, frameDeps);
			},
			close(ws) {
				resolveDrainWaiters(ws); // never park a queued send on a socket that's gone
				connections.remove(ws);
				noteActivity();
			},
			drain(ws) {
				resolveDrainWaiters(ws);
			},
		},
		fetch(req, server) {
			const url = new URL(req.url);

			if (url.pathname === "/health") {
				const failsHostOrOrigin =
					!isLoopbackHost(req.headers.get("host"), port) ||
					isBrowserOrigin(req.headers.get("origin"));
				if (failsHostOrOrigin) {
					return new Response(null, { status: 204 });
				}
				return json({
					daemon: "dg-server",
					protocolVersion: CHAT_PROTOCOL_VERSION,
					instanceId: deps.instanceId,
				});
			}

			const hostError = requireLoopbackHost(req, port);
			if (hostError) return hostError;

			if (url.pathname === "/status" && req.method === "GET") {
				return json(
					renderStatus({
						...deps.statusDeps,
						instanceId: deps.instanceId,
						boundPort: port,
						registry,
					}),
				);
			}

			if (url.pathname === "/start" && req.method === "GET") {
				return new Response(bootstrapPageHtml(), {
					headers: { "Content-Type": "text/html; charset=utf-8" },
				});
			}

			if (url.pathname === "/start" && req.method === "POST") {
				return handleRegisterSession(req, deps);
			}

			if (url.pathname === "/ws") {
				return handleWsUpgrade(req, server, deps);
			}

			if (url.pathname === "/cli") {
				return handleCliUpgrade(req, server, deps);
			}

			return new Response("not found", { status: 404 });
		},
	});
}

async function handleRegisterSession(
	req: Request,
	deps: HttpServerDeps,
): Promise<Response> {
	// Mints a live session capability, same as /cli's own upgrade — no
	// legitimate caller (the CLI's own fetch) ever carries a browser Origin.
	if (isBrowserOrigin(req.headers.get("origin"))) {
		return new Response("refused: /start rejects a browser Origin", {
			status: 400,
		});
	}
	// A CORS preflight guards any non-simple Content-Type, so a cross-origin
	// POST from an attacker page never reaches this handler — hence the exact check.
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
			? input.agentIdentity
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
	// Session-list broadcasting is centralized on registry's "changed" event
	// (wired once in bootstrap.ts) — deps.registry.create() above already fired it.

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
	const sessionId = req.headers.get(CLI_SESSION_ID_HEADER);
	const token = req.headers.get(CLI_SESSION_TOKEN_HEADER);
	if (!sessionId || !token || !deps.registry.validate(sessionId, token)) {
		return new Response("refused: invalid or unknown session capability", {
			status: 401,
		});
	}
	const data = createSocketState("cli", deps.logger);
	data.capabilities.set(sessionId, token);
	const upgraded = server.upgrade(req, { data });
	if (!upgraded) return new Response("upgrade failed", { status: 500 });
	return new Response(null, { status: 101 });
}

export function newInstanceId(): string {
	return randomUUID();
}
