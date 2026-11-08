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
