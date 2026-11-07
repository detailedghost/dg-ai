import { afterEach, describe, expect, it } from "bun:test";
import {
	CHAT_CODE_PATH,
	CHAT_EXCHANGE_PATH,
	type SessionBootstrap,
} from "@dg/common";
import {
	bootServe,
	BROWSER_ORIGIN,
	cleanupDgHome,
	createCleanupSlot,
	EXTENSION_ORIGIN,
	ownerTokenHeader,
	registerSession,
	stopServe,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function boot() {
	const { dgHome, port, proc } = await bootServe();
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	const session = await registerSession(port);
	return { port, session };
}

function mint(
	port: number,
	session: SessionBootstrap,
	options: { origin?: string | null; token?: string | null } = {},
) {
	const origin = options.origin === undefined ? EXTENSION_ORIGIN : options.origin;
	const token = options.token === undefined ? session.token : options.token;
	return fetch(`http://127.0.0.1:${port}${CHAT_CODE_PATH}`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			...(origin === null ? {} : { Origin: origin }),
			...(token === null ? {} : { Authorization: `Bearer ${token}` }),
		},
	});
}

function exchange(
	port: number,
	code: unknown,
	origin: string | null = `http://127.0.0.1:${port}`,
) {
	return fetch(`http://127.0.0.1:${port}${CHAT_EXCHANGE_PATH}`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			"Content-Type": "application/json",
			...(origin === null ? {} : { Origin: origin }),
		},
		body: JSON.stringify({ code }),
	});
}

async function mintCode(port: number, session: SessionBootstrap): Promise<string> {
	const response = await mint(port, session);
	expect(response.status).toBe(200);
	return ((await response.json()) as { code: string }).code;
}

describe("POST /chat/code", () => {
	it("mints a code for the session whose live token the extension presents", async () => {
		const { port, session } = await boot();

		const response = await mint(port, session);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(typeof ((await response.json()) as { code: unknown }).code).toBe("string");
	});

	it("refuses a request without a live session bearer", async () => {
		const { port, session } = await boot();

		expect((await mint(port, session, { token: null })).status).toBe(403);
		expect((await mint(port, session, { token: "not-a-token" })).status).toBe(403);
	});

	it("refuses an Origin that is not an extension origin", async () => {
		const { port, session } = await boot();

		expect((await mint(port, session, { origin: BROWSER_ORIGIN })).status).toBe(400);
		expect((await mint(port, session, { origin: null })).status).toBe(400);
	});
});

function mintAsOwner(
	port: number,
	body: unknown,
	options: { origin?: string; owner?: Record<string, string> } = {},
) {
	return fetch(`http://127.0.0.1:${port}${CHAT_CODE_PATH}`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			"Content-Type": "application/json",
			...(options.origin === undefined ? {} : { Origin: options.origin }),
			...(options.owner ?? ownerTokenHeader(port)),
		},
		body: JSON.stringify(body),
	});
}

describe("POST /chat/code with the owner token", () => {
	it("mints a code for an active session and the code exchanges for that session", async () => {
		const { port, session } = await boot();

		const response = await mintAsOwner(port, { sessionId: session.sessionId });
		const { code } = (await response.json()) as { code: string };
		const traded = await exchange(port, code);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(((await traded.json()) as { sessionId: string }).sessionId).toBe(
			session.sessionId,
		);
	});

	it("refuses an Origin header next to the owner header", async () => {
		const { port, session } = await boot();

		const response = await mintAsOwner(
			port,
			{ sessionId: session.sessionId },
			{ origin: EXTENSION_ORIGIN },
		);

		expect(response.status).toBe(400);
	});

	it("answers 404 for an unknown session", async () => {
		const { port } = await boot();

		expect((await mintAsOwner(port, { sessionId: "no-such-session" })).status).toBe(404);
	});

	it("answers 404 for a closed session", async () => {
		const { port, session } = await boot();
		const closed = await fetch(`http://127.0.0.1:${port}/sessions/clear`, {
			method: "POST",
			headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
		});
		expect(closed.status).toBe(200);

		expect((await mintAsOwner(port, { sessionId: session.sessionId })).status).toBe(404);
	});

	it("refuses a wrong owner token and a body without a sessionId", async () => {
		const { port, session } = await boot();

		const wrong = await mintAsOwner(
			port,
			{ sessionId: session.sessionId },
			{ owner: { "X-Dg-Owner-Token": "wrong" } },
		);
		const empty = await mintAsOwner(port, {});

		expect(wrong.status).toBe(401);
		expect(empty.status).toBe(400);
	});
});

describe("POST /chat/exchange", () => {
	it("trades a code for the session bootstrap exactly once", async () => {
		const { port, session } = await boot();
		const code = await mintCode(port, session);

		const first = await exchange(port, code);
		const second = await exchange(port, code);

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({
			port,
			sessionId: session.sessionId,
			token: session.token,
			agentIdentity: session.agentIdentity,
		});
		expect(second.status).toBe(404);
	});

	it("answers 404 for a code the daemon never minted", async () => {
		const { port } = await boot();

		expect((await exchange(port, "unknown-code")).status).toBe(404);
	});

	it("refuses a request whose Origin is not the daemon's own page", async () => {
		const { port, session } = await boot();
		const code = await mintCode(port, session);

		expect((await exchange(port, code, EXTENSION_ORIGIN)).status).toBe(400);
		expect((await exchange(port, code, BROWSER_ORIGIN)).status).toBe(400);
		expect((await exchange(port, code, null)).status).toBe(400);
		expect((await exchange(port, code)).status).toBe(200);
	});

	it("refuses a body without a string code", async () => {
		const { port } = await boot();

		expect((await exchange(port, 7)).status).toBe(400);
	});
});
