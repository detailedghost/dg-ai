import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { CHAT_PROTOCOL_VERSION, DgCliError } from "@dg/common";
import {
	resolveCliSession,
	resolveDgPaths,
	type SessionTokenRecord,
	selectSoleSession,
} from "@dg/common/node";
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	frameType,
	freshTempDir,
	killDaemonByPidFile,
	registerSession,
	send,
	sendConnectHandshake,
	startWithSession,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

const DELIVERY_BUDGET_MS = 1000;

let dgHome: string;
const sockets: WebSocket[] = [];

afterEach(() => {
	closeSockets(sockets);
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

type Frame = Record<string, unknown>;

function sessionListPresence(frame: unknown, sessionId: string): unknown {
	const sessions = (frame as { sessions?: Frame[] }).sessions ?? [];
	return sessions.find((entry) => entry.sessionId === sessionId)?.presence;
}

async function connectPageSocket(
	port: number,
	credentials: { sessionId: string; token: string },
) {
	const page = wsExtensionSocket(port);
	sockets.push(page);
	const frames = collectFrames(page);
	await waitForOpen(page);
	sendConnectHandshake(page, credentials, CHAT_PROTOCOL_VERSION);
	await waitForValue(
		() => frames.find((frame) => frameType(frame) === "session-list"),
		DELIVERY_BUDGET_MS,
		"the handshake session-list",
	);
	return { page, frames };
}

describe("page user-message delivery through the daemon", () => {
	it("acks the page and hands the body to the CLI socket of the same session", async () => {
		const { dgHome: home, port, bootstrap } = await startWithSession();
		dgHome = home;
		const { page, frames } = await connectPageSocket(port, bootstrap);
		const cli = await connectCli(port, bootstrap);
		sockets.push(cli);
		const cliFrames = collectFrames(cli);
		send(cli, { type: "cli-recv", block: true, timeoutMs: 5000 });
		await new Promise((resolve) => setTimeout(resolve, 100));

		const messageId = randomUUID();
		const sentAt = Date.now();
		send(page, {
			type: "user-message",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			messageId,
			body: "hello agent",
		});

		const ack = await waitForValue(
			() => frames.find((frame) => frameType(frame) === "ack"),
			DELIVERY_BUDGET_MS,
			"the ack on the page socket",
		);
		const result = (await waitForValue(
			() => cliFrames.find((frame) => frameType(frame) === "cli-recv-result"),
			DELIVERY_BUDGET_MS,
			"the cli-recv-result on the CLI socket",
		)) as { outcome: string; message?: { body?: string } };

		expect((ack as { messageId: string }).messageId).toBe(messageId);
		expect(result.outcome).toBe("delivered");
		expect(result.message?.body).toBe("hello agent");
		expect(Date.now() - sentAt).toBeLessThan(DELIVERY_BUDGET_MS);
	});
});

describe("session-list presence on a long-lived page socket", () => {
	it("re-broadcasts the session-list with presence cli when a CLI socket attaches after the page connected", async () => {
		const { dgHome: home, port, bootstrap } = await startWithSession();
		dgHome = home;
		const { frames } = await connectPageSocket(port, bootstrap);
		const first = frames.find((frame) => frameType(frame) === "session-list");
		expect(sessionListPresence(first, bootstrap.sessionId)).not.toBe("cli");
		const before = frames.filter((f) => frameType(f) === "session-list").length;

		const cli = await connectCli(port, bootstrap);
		sockets.push(cli);
		send(cli, { type: "cli-recv", block: false });

		const attached = await waitForValue(
			() =>
				frames
					.filter((frame) => frameType(frame) === "session-list")
					.slice(before)
					.find((frame) => sessionListPresence(frame, bootstrap.sessionId) === "cli"),
			DELIVERY_BUDGET_MS,
			"a second session-list with presence cli",
		);

		expect(attached).toBeDefined();
	});
});

describe("selectSoleSession when two live sessions share one working directory", () => {
	const record = (sessionId: string, cwd: string): SessionTokenRecord => ({
		sessionId,
		token: `token-${sessionId}`,
		cwd,
		agentIdentity: "agent",
	});

	it("refuses to pick one and asks for an explicit session id", () => {
		const cwd = freshTempDir("dg-sole-session");

		expect(() =>
			selectSoleSession([record("a", cwd), record("b", cwd)], cwd),
		).toThrow(DgCliError);
		expect(() =>
			selectSoleSession([record("a", cwd), record("b", cwd)], cwd),
		).toThrow(/found 2 matches/);
	});

	it("picks the only session registered for the directory", () => {
		const cwd = freshTempDir("dg-sole-session");
		const other = freshTempDir("dg-sole-session");

		expect(selectSoleSession([record("a", cwd), record("b", other)], cwd).sessionId).toBe("a");
	});
});

describe("resolveCliSession when two live sessions share one working directory", () => {
	it("honors DG_SESSION_ID before cwd matching", async () => {
		const started = await startWithSession();
		dgHome = started.dgHome;
		const second = await registerSession(started.port);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });

		await expect(resolveCliSession(undefined, paths, {})).rejects.toThrow(
			/found 2 matches/,
		);
		const resolved = await resolveCliSession(undefined, paths, {
			DG_SESSION_ID: second.sessionId,
		});

		expect(resolved.sessionId).toBe(second.sessionId);
	});

	it("prefers an explicit session id over DG_SESSION_ID", async () => {
		const started = await startWithSession();
		dgHome = started.dgHome;
		const second = await registerSession(started.port);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });

		const resolved = await resolveCliSession(started.bootstrap.sessionId, paths, {
			DG_SESSION_ID: second.sessionId,
		});

		expect(resolved.sessionId).toBe(started.bootstrap.sessionId);
	});
});
