import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { getPinnedOrigin } from "../../src/server/origin";
import {
	bootServe,
	cleanupDgHome,
	closeSession,
	collectFrames,
	connectPage,
	createCleanupSlot,
	EXTENSION_ORIGIN,
	frameType,
	registerSession,
	sendConnectHandshake,
	stopServe,
	waitForOpen,
	waitForValue,
	wsUrl,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function boot() {
	const running = await bootServe();
	cleanupSlot.set(async () => {
		await stopServe(running.proc);
		cleanupDgHome(running.dgHome);
	});
	return running;
}

function loopbackOrigin(port: number, host = "127.0.0.1"): string {
	return `http://${host}:${port}`;
}

function request(
	port: number,
	path: string,
	init: {
		origin?: string;
		token?: string;
		method?: string;
		body?: unknown;
	} = {},
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: init.method ?? "GET",
		headers: {
			Host: `127.0.0.1:${port}`,
			...(init.origin === undefined ? {} : { Origin: init.origin }),
			...(init.token === undefined
				? {}
				: { Authorization: `Bearer ${init.token}` }),
			...(init.body === undefined
				? {}
				: { "Content-Type": "application/json" }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
}

function upgrade(
	port: number,
	path: string,
	headers: Record<string, string>,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		headers: {
			Host: `127.0.0.1:${port}`,
			Connection: "Upgrade",
			Upgrade: "websocket",
			"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			"Sec-WebSocket-Version": "13",
			...headers,
		},
	});
}

type OriginSocketCtor = new (
	url: string,
	options: { headers: Record<string, string> },
) => WebSocket;

function loopbackSocket(
	port: number,
	origin: string,
	token: string,
): WebSocket {
	const Ctor = WebSocket as unknown as OriginSocketCtor;
	return new Ctor(`${wsUrl(port, "/ws")}?token=${encodeURIComponent(token)}`, {
		headers: { Origin: origin },
	});
}

function settles(ws: WebSocket): Promise<"open" | "error" | "close"> {
	return new Promise((resolve) => {
		ws.addEventListener("open", () => resolve("open"), { once: true });
		ws.addEventListener("error", () => resolve("error"), { once: true });
		ws.addEventListener("close", () => resolve("close"), { once: true });
	});
}

describe("GET /chat and GET /board page shells", () => {
	for (const path of ["/chat", "/board"]) {
		it(`serves ${path} as html with the CSP and framing headers and no token`, async () => {
			const { port } = await boot();
			const session = await registerSession(port);

			const response = await request(port, path);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toStartWith("text/html");
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(response.headers.get("X-Frame-Options")).toBe("DENY");
			const csp = response.headers.get("Content-Security-Policy") ?? "";
			expect(csp).toContain("default-src 'none'");
			expect(csp).toContain("script-src 'self'");
			expect(csp).toContain(`connect-src 'self' ws://127.0.0.1:${port}`);
			expect(csp).toContain("style-src 'self' 'unsafe-inline'");
			expect(csp).toContain("img-src 'self' data: blob:");
			const html = await response.text();
			expect(html.toLowerCase()).toContain("<!doctype html");
			expect(html).not.toContain(session.token);
			expect(html).not.toContain(session.sessionId);
		});
	}

	it("serves a different shell for /chat than for /board", async () => {
		const { port } = await boot();

		const chat = await (await request(port, "/chat")).text();
		const board = await (await request(port, "/board")).text();

		expect(chat).not.toBe(board);
	});

	it("serves /chat.js and /board.js as scripts with nosniff and framing headers", async () => {
		const { port } = await boot();

		for (const path of ["/chat.js", "/board.js"]) {
			const response = await request(port, path);

			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Type")).toStartWith(
				"text/javascript",
			);
			expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(response.headers.get("X-Frame-Options")).toBe("DENY");
			expect((await response.text()).length).toBeGreaterThan(0);
		}
	});

	it("refuses /chat with a foreign Host header", async () => {
		const { port } = await boot();

		const response = await fetch(`http://127.0.0.1:${port}/chat`, {
			headers: { Host: "evil.example" },
		});

		expect(response.status).toBe(400);
	});

	it("does not serve the page shell for POST /chat", async () => {
		const { port } = await boot();

		const response = await request(port, "/chat", { method: "POST", body: {} });

		expect([404, 405]).toContain(response.status);
	});

	it("keeps the legacy /start stub for old extensions", async () => {
		const { port } = await boot();

		const response = await request(port, "/start");

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toStartWith("text/html");
	});
});

describe("GET /overwatch with a loopback Origin", () => {
	it("returns the board JSON for a valid Bearer token on 127.0.0.1 and localhost", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		for (const host of ["127.0.0.1", "localhost"]) {
			const response = await request(port, "/overwatch", {
				origin: loopbackOrigin(port, host),
				token: session.token,
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(await response.json()).toMatchObject({ lanes: [] });
		}
	});

	it("refuses a missing token with 403 and no body detail", async () => {
		const { port } = await boot();
		await registerSession(port);

		const response = await request(port, "/overwatch", {
			origin: loopbackOrigin(port),
		});

		expect(response.status).toBe(403);
		expect((await response.text()).length).toBeLessThan(32);
	});

	it("refuses a query token on GET /overwatch with 403", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const response = await request(
			port,
			`/overwatch?token=${encodeURIComponent(session.token)}`,
			{ origin: loopbackOrigin(port) },
		);

		expect(response.status).toBe(403);
	});

	it("refuses a wrong token with 403", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const response = await request(port, "/overwatch", {
			origin: loopbackOrigin(port),
			token: `${session.token}-stale`,
		});

		expect(response.status).toBe(403);
	});

	it("refuses a loopback Origin carrying the right token on the wrong port", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const response = await request(port, "/overwatch", {
			origin: loopbackOrigin(port + 1),
			token: session.token,
		});

		expect(response.status).toBe(400);
	});

	it("keeps refusing a foreign Origin with 400 even with a valid token", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const response = await request(port, "/overwatch", {
			origin: "https://evil.example",
			token: session.token,
		});

		expect(response.status).toBe(400);
	});

	it("refuses POST /overwatch/action without a valid token", async () => {
		const { port } = await boot();
		const session = await registerSession(port);
		const body = { chat: "print", action: "approve" };

		const missing = await request(port, "/overwatch/action", {
			method: "POST",
			origin: loopbackOrigin(port),
			body,
		});
		const wrong = await request(port, "/overwatch/action", {
			method: "POST",
			origin: loopbackOrigin(port),
			token: `${session.token}-stale`,
			body,
		});

		expect(missing.status).toBe(403);
		expect(wrong.status).toBe(403);
	});

	it("passes the gate on POST /overwatch/action with a valid token", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const response = await request(port, "/overwatch/action", {
			method: "POST",
			origin: loopbackOrigin(port),
			token: session.token,
			body: { chat: "missing", action: "approve" },
		});

		expect(response.status).toBe(404);
	});
});

describe("GET /overwatch with no Origin header", () => {
	it("returns the board for a valid Bearer token", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const response = await request(port, "/overwatch", {
			token: session.token,
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ lanes: [] });
	});

	it("refuses a wrong Bearer token with 403, not 400", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const response = await request(port, "/overwatch", {
			token: `${session.token}-stale`,
		});

		expect(response.status).toBe(403);
	});

	it("keeps refusing a request with no token with 400", async () => {
		const { port } = await boot();
		await registerSession(port);

		const response = await request(port, "/overwatch");

		expect(response.status).toBe(400);
	});

	it("does not treat the literal Origin null as a local page", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const response = await request(port, "/overwatch", {
			origin: "null",
			token: session.token,
		});

		expect(response.status).toBe(400);
	});
});

describe("/ws upgrade with a loopback Origin", () => {
	it("accepts the upgrade for a live session token", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const ws = loopbackSocket(port, loopbackOrigin(port), session.token);
		try {
			await waitForOpen(ws);
			expect(ws.readyState).toBe(WebSocket.OPEN);
		} finally {
			ws.close();
		}
	});

	it("does not pin a loopback Origin as the extension origin", async () => {
		const { port, dgHome } = await boot();
		const session = await registerSession(port);

		const ws = loopbackSocket(port, loopbackOrigin(port), session.token);
		const frames = collectFrames(ws);
		await waitForOpen(ws);
		sendConnectHandshake(ws, session, CHAT_PROTOCOL_VERSION);
		await waitForValue(
			() => frames.find((frame) => frameType(frame) === "session-list"),
			3000,
			"session-list after connect",
		);
		ws.close();

		expect(frames.filter((frame) => frameType(frame) === "error")).toEqual([]);

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(getPinnedOrigin(paths)).toBeUndefined();
	});

	it("accepts the upgrade from the localhost Origin with a live token", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const ws = loopbackSocket(
			port,
			loopbackOrigin(port, "localhost"),
			session.token,
		);
		try {
			await waitForOpen(ws);
			expect(ws.readyState).toBe(WebSocket.OPEN);
		} finally {
			ws.close();
		}
	});

	it("refuses an upgrade with no Origin even with a live token", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const raw = await upgrade(
			port,
			`/ws?token=${encodeURIComponent(session.token)}`,
			{},
		);

		expect(raw.status).toBe(400);
	});

	it("refuses the token of a closed session on upgrade and on GET /overwatch", async () => {
		const { port, dgHome } = await boot();
		const session = await registerSession(port);
		await closeSession(dgHome, port, session.sessionId);

		const raw = await upgrade(
			port,
			`/ws?token=${encodeURIComponent(session.token)}`,
			{ Origin: loopbackOrigin(port) },
		);
		const board = await request(port, "/overwatch", {
			origin: loopbackOrigin(port),
			token: session.token,
		});

		expect(raw.status).toBe(403);
		expect(board.status).toBe(403);
	});

	it("refuses a stale token before the socket opens", async () => {
		const { port } = await boot();
		const session = await registerSession(port);
		const origin = loopbackOrigin(port);

		const raw = await upgrade(
			port,
			`/ws?token=${encodeURIComponent(`${session.token}-stale`)}`,
			{ Origin: origin },
		);
		expect(raw.status).toBe(403);

		const ws = loopbackSocket(port, origin, `${session.token}-stale`);
		expect(await settles(ws)).not.toBe("open");
	});

	it("refuses a missing token before the socket opens", async () => {
		const { port } = await boot();
		await registerSession(port);

		const raw = await upgrade(port, "/ws", { Origin: loopbackOrigin(port) });

		expect(raw.status).toBe(403);
	});

	it("refuses a token presented from a foreign Origin", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const raw = await upgrade(
			port,
			`/ws?token=${encodeURIComponent(session.token)}`,
			{ Origin: "https://evil.example" },
		);

		expect(raw.status).toBe(400);
	});
});

describe("pinned extension origin keeps working for --ext", () => {
	it("passes GET /overwatch and POST /overwatch/action without a token", async () => {
		const { port } = await boot();
		const session = await registerSession(port, { agentIdentity: "ext-test" });
		const page = await connectPage(port, session);
		page.close();

		const read = await request(port, "/overwatch", {
			origin: EXTENSION_ORIGIN,
		});
		const action = await request(port, "/overwatch/action", {
			method: "POST",
			origin: EXTENSION_ORIGIN,
			body: { chat: "missing", action: "approve" },
		});

		expect(read.status).toBe(200);
		expect(action.status).toBe(404);
	});

	it("still upgrades /ws from the extension origin with no query token", async () => {
		const { port } = await boot();
		const session = await registerSession(port);

		const page = await connectPage(port, session);

		expect(page.readyState).toBe(WebSocket.OPEN);
		page.close();
	});
});
