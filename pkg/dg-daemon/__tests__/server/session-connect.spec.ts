import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, OWNER_TOKEN_HEADER } from "@dg/common";
import {
	readOwnerToken,
	resolveDgPaths,
	writePidFileAtomic,
} from "@dg/common/node";
import { statSync } from "node:fs";
import { writeConfig } from "../../src/server/config-store";
import {
	allocatePort,
	cleanupDgHome,
	cliSocket,
	collectFrames,
	connectPage,
	EXTENSION_ORIGIN,
	frameType,
	freshDgHome,
	ownerTokenHeader,
	registerSession,
	runDaemonCommand,
	runStatus,
	sendConnectHandshake,
	spawnServe,
	stopServe,
	waitForHealth,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";
import { readSessionList } from "../utils/session-list";

let dgHome = "";
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	stop = undefined;
	if (dgHome) cleanupDgHome(dgHome);
});

async function boot() {
	dgHome = freshDgHome();
	const port = allocatePort();
	const proc = spawnServe(dgHome, port, {
		DG_IDLE_TTL_MS: "600000",
	});
	await waitForHealth(port);
	stop = async () => {
		await stopServe(proc);
	};
	return { port, paths: resolveDgPaths({ env: { DG_HOME: dgHome } }) };
}

function ownerHeaders(port: number): Record<string, string> {
	const token = readOwnerToken(resolveDgPaths({ env: { DG_HOME: dgHome } }));
	if (token === undefined) throw new Error("owner token was not written");
	return { Host: `127.0.0.1:${port}`, [OWNER_TOKEN_HEADER]: token };
}

function extensionPost(port: number, path: string, body: unknown) {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			Origin: EXTENSION_ORIGIN,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

describe("connection handshake", () => {
	it("accepts a real capability with session-list and rejects a bad token without echoing it", async () => {
		const { port } = await boot();
		const bootstrap = await registerSession(port, { agentIdentity: "claude" });
		const ws = wsExtensionSocket(port);
		await waitForOpen(ws);
		const frames = collectFrames(ws);
		sendConnectHandshake(ws, bootstrap, CHAT_PROTOCOL_VERSION);
		const listed = await waitForValue(
			() => frames.find((frame) => frameType(frame) === "session-list"),
			2000,
			"session-list",
		);
		expect(JSON.stringify(listed)).not.toContain(bootstrap.token);

		sendConnectHandshake(
			ws,
			{ ...bootstrap, token: "not-the-real-token" },
			CHAT_PROTOCOL_VERSION,
		);
		const error = await waitForValue(
			() => frames.find((frame) => frameType(frame) === "error"),
			2000,
			"invalid session error",
		);
		const text = JSON.stringify(error);
		expect(text).toContain("invalid-session");
		expect(text).not.toContain(bootstrap.token);
		expect(text).not.toContain("not-the-real-token");
		ws.close();
	});
});

describe("session presence in the session-list frame", () => {
	it("lists a started session as idle, then cli once the CLI socket opens", async () => {
		const { port } = await boot();
		const bootstrap = await registerSession(port, { agentIdentity: "claude" });

		expect(
			(await readSessionList(port, bootstrap)).map((session) => session.presence),
		).toEqual(["idle"]);

		const cli = cliSocket(port, bootstrap);
		await waitForOpen(cli);

		expect(
			(await readSessionList(port, bootstrap)).map((session) => session.presence),
		).toEqual(["cli"]);
		cli.close();
	});
});

describe("code pairing is removed", () => {
	it.each(["/pair/offer", "/pair/offer/0b7c1a52-0000-4000-8000-000000000000", "/pair/claim"])(
		"answers POST %s with 404",
		async (path) => {
			const { port } = await boot();

			const response = await extensionPost(port, path, {});

			expect(response.status).toBe(404);
		},
	);

	it.each([
		["a code", { intent: "attach", code: "123456" }],
		["the all flag", { intent: "attach", all: true }],
		["a code and the all flag", { intent: "attach", all: true, code: "123456" }],
	])("refuses an extension /attach with %s and leaks no token", async (_name, body) => {
		const { port, paths } = await boot();
		writeConfig(paths, { pinnedOrigin: EXTENSION_ORIGIN });
		const bootstrap = await registerSession(port, { agentIdentity: "claude" });

		const response = await extensionPost(port, "/attach", body);

		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain(bootstrap.token);
	});

	it("refuses an extension /attach that names a session", async () => {
		const { port, paths } = await boot();
		writeConfig(paths, { pinnedOrigin: EXTENSION_ORIGIN });
		const bootstrap = await registerSession(port, { agentIdentity: "claude" });

		const response = await extensionPost(port, "/attach", {
			intent: "attach",
			sessionId: bootstrap.sessionId,
		});

		expect(response.status).toBe(400);
		expect(await response.text()).not.toContain(bootstrap.token);
	});

	it("has no dg-daemon pair command", async () => {
		dgHome = freshDgHome();

		const result = await runDaemonCommand(dgHome, "pair");

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toMatch(/unknown command/);
	});
});

describe("POST /start origin policy", () => {
	it.each([
		["an unpinned extension Origin", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
		["a Firefox extension Origin", "moz-extension://abc"],
		["the literal null Origin", "null"],
		["a web Origin", "http://evil.example"],
	])("refuses %s and creates no session", async (_name, origin) => {
		const { port } = await boot();

		const response = await fetch(`http://127.0.0.1:${port}/start`, {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${port}`,
				Origin: origin,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ cwd: process.cwd(), role: "agent" }),
		});

		expect(response.status).toBe(400);
		const status = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(status.sessionCount).toBe(0);
	});
});

describe("POST /start owner credential", () => {
	function startRequest(port: number, headers: Record<string, string>) {
		return fetch(`http://127.0.0.1:${port}/start`, {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${port}`,
				"Content-Type": "application/json",
				...headers,
			},
			body: JSON.stringify({ cwd: process.cwd(), role: "agent" }),
		});
	}

	it("refuses a caller with no owner token and creates no session", async () => {
		const { port } = await boot();

		const response = await startRequest(port, {});

		expect(response.status).toBe(401);
		const status = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(status.sessionCount).toBe(0);
	});

	it("refuses a wrong owner token", async () => {
		const { port } = await boot();

		const response = await startRequest(port, { [OWNER_TOKEN_HEADER]: "wrong" });

		expect(response.status).toBe(401);
	});

	it("registers a session when the owner token is sent", async () => {
		const { port } = await boot();

		const response = await startRequest(port, ownerTokenHeader(port));

		expect(response.status).toBe(200);
	});
});

describe("session catalog route", () => {
	it.each([
		["/sessions", undefined],
		["/sessions?waiting=1", undefined],
		["/sessions", EXTENSION_ORIGIN],
		["/sessions?waiting=1", EXTENSION_ORIGIN],
	])("answers GET %s with 404 for origin %p", async (path, origin) => {
		const { port, paths } = await boot();
		writeConfig(paths, { pinnedOrigin: EXTENSION_ORIGIN });
		const bootstrap = await registerSession(port, { agentIdentity: "claude" });

		const response = await fetch(`http://127.0.0.1:${port}${path}`, {
			headers: {
				Host: `127.0.0.1:${port}`,
				...(origin === undefined ? {} : { Origin: origin }),
			},
		});

		expect(response.status).toBe(404);
		expect(await response.text()).not.toContain(bootstrap.sessionId);
	});
});

describe("manual cleanup", () => {
	it("closes the session with no CLI and leaves the one with a live CLI socket", async () => {
		const { port } = await boot();
		const idle = await registerSession(port, { agentIdentity: "old" });
		const driven = await registerSession(port, { agentIdentity: "next" });
		const cli = cliSocket(port, {
			sessionId: driven.sessionId,
			token: driven.token,
		});
		await waitForOpen(cli);

		const cleared = await fetch(`http://127.0.0.1:${port}/sessions/clear`, {
			method: "POST",
			headers: ownerHeaders(port),
		});

		expect(((await cleared.json()) as { closed: string[] }).closed).toEqual([
			idle.sessionId,
		]);
		cli.close();
	});

	it("refuses a local token read and a clear that omit the owner credential", async () => {
		const { port, paths } = await boot();
		const bootstrap = await registerSession(port, { agentIdentity: "claude" });
		expect(statSync(`${paths.daemonDir}/owner.token`).mode & 0o777).toBe(0o600);

		const listed = await fetch(`http://127.0.0.1:${port}/sessions/local`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		const listedBody = await listed.text();
		expect(listed.status).toBe(401);
		expect(listedBody).not.toContain(bootstrap.token);

		const wrong = await fetch(
			`http://127.0.0.1:${port}/sessions/local?session=${bootstrap.sessionId}`,
			{
				headers: {
					Host: `127.0.0.1:${port}`,
					[OWNER_TOKEN_HEADER]: "not-the-owner-credential",
				},
			},
		);
		expect(wrong.status).toBe(401);
		expect(await wrong.text()).not.toContain(bootstrap.token);

		const cleared = await fetch(`http://127.0.0.1:${port}/sessions/clear`, {
			method: "POST",
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(cleared.status).toBe(401);
		expect(await cleared.text()).not.toContain(bootstrap.token);

		const named = await fetch(
			`http://127.0.0.1:${port}/sessions/local?session=${bootstrap.sessionId}`,
			{ headers: ownerHeaders(port) },
		);
		const namedBody = (await named.json()) as {
			sessions: { token?: string }[];
		};
		expect(named.status).toBe(200);
		expect(namedBody.sessions).toHaveLength(1);
		expect(namedBody.sessions[0]?.token).toBe(bootstrap.token);

		const all = await fetch(`http://127.0.0.1:${port}/sessions/local`, {
			headers: ownerHeaders(port),
		});
		expect(JSON.stringify(await all.json())).not.toContain(bootstrap.token);
	});

	it("prints the clear status and redacts the body when the daemon refuses", async () => {
		dgHome = freshDgHome();
		const secret = "sk-clearerr-should-not-leak";
		const server = Bun.serve({
			port: 0,
			fetch() {
				return new Response(secret, { status: 503 });
			},
		});
		try {
			const port = server.port;
			if (port === undefined) throw new Error("clear server did not bind");
			writePidFileAtomic(resolveDgPaths({ env: { DG_HOME: dgHome } }), {
				pid: process.pid,
				port,
				instanceId: "clear-error",
				versions: { package: "0.0.0", protocol: CHAT_PROTOCOL_VERSION },
			});
			const result = await runDaemonCommand(dgHome, "sessions", "clear");
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("503");
			expect(result.stderr).not.toContain("Pair the extension");
			expect(result.stderr).not.toContain(secret);
			expect(result.stderr).toContain("[redacted]");
		} finally {
			server.stop(true);
		}
	});
});
