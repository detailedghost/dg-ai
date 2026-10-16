import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
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

describe("extension to CLI and CLI to extension", () => {
	it("attaches an already-open CLI session instead of minting an orphan", async () => {
		const { port } = await boot();
		const bootstrap = await registerSession(port, { agentIdentity: "claude" });
		const paired = await runDaemonCommand(dgHome, "pair");
		const code = paired.stdout.match(/Pairing code: (\d{6})/)?.[1];
		expect(code).toBeDefined();

		const response = await extensionPost(port, "/attach", {
			intent: "attach",
			all: true,
			code,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			sessions: { sessionId: string; token: string; agentIdentity: string }[];
		};
		expect(body.sessions.map((session) => session.sessionId)).toEqual([
			bootstrap.sessionId,
		]);
		expect(body.sessions[0]?.agentIdentity).toBe("claude");
		expect(body.sessions[0]?.token).toBe(bootstrap.token);

		const status = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(status.sessionCount).toBe(1);
	});

	it("creates a waiting session the CLI catalog can see without a token, then a live CLI is not clearable", async () => {
		const { port, paths } = await boot();
		writeConfig(paths, { pinnedOrigin: EXTENSION_ORIGIN });
		const created = await extensionPost(port, "/sessions", {
			agentIdentity: "claude",
		});
		expect(created.status).toBe(200);
		const bootstrap = (await created.json()) as { sessionId: string; token: string };
		expect(bootstrap.token.length).toBeGreaterThan(8);

		const catalog = await fetch(`http://127.0.0.1:${port}/sessions?waiting=1`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		const listed = (await catalog.json()) as {
			sessions: { sessionId: string; awaitingAgent: boolean; token?: string; cwd: string }[];
		};
		expect(listed.sessions.map((session) => session.sessionId)).toEqual([
			bootstrap.sessionId,
		]);
		expect(listed.sessions[0]?.awaitingAgent).toBe(true);
		expect(JSON.stringify(listed)).not.toContain(bootstrap.token);

		const cli = cliSocket(port, {
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		await waitForOpen(cli);

		const cleared = await fetch(`http://127.0.0.1:${port}/sessions/clear`, {
			method: "POST",
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(((await cleared.json()) as { closed: string[] }).closed).toEqual([]);

		const page = await connectPage(port, {
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		cli.close();
		page.close();
	});
});

describe("manual cleanup", () => {
	it("closes disconnected sessions and leaves one that is still waiting", async () => {
		const { port, paths } = await boot();
		writeConfig(paths, { pinnedOrigin: EXTENSION_ORIGIN });
		const idle = await registerSession(port, { agentIdentity: "old" });
		const waiting = await extensionPost(port, "/sessions", { agentIdentity: "next" });
		const waitingBody = (await waiting.json()) as { sessionId: string };

		const cleared = await fetch(`http://127.0.0.1:${port}/sessions/clear`, {
			method: "POST",
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(((await cleared.json()) as { closed: string[] }).closed).toEqual([
			idle.sessionId,
		]);

		const catalog = await fetch(`http://127.0.0.1:${port}/sessions`, {
			headers: { Host: `127.0.0.1:${port}`, Origin: EXTENSION_ORIGIN },
		});
		const body = (await catalog.json()) as { sessions: { sessionId: string }[] };
		expect(body.sessions.map((session) => session.sessionId)).toEqual([
			waitingBody.sessionId,
		]);
		expect(JSON.stringify(body)).not.toContain(idle.token);
	});
});
