import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { inboxSendApproval } from "../../../common/__tests__/utils/inbox-fixtures";
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	wsExtensionSocket,
	waitForOpen,
	frameType,
	killDaemonByPidFile,
	registerSession,
	send,
	startWithSession,
	waitForValue,
} from "../utils/daemon-harness";

type InboxResult = {
	type: string;
	sessionId: string;
	requestId: string;
	ok: boolean;
	value?: unknown;
	error?: string;
};
type ApprovalRequestFrame = {
	type: string;
	sessionId: string;
	requestId: string;
	approval: unknown;
};
const sockets: WebSocket[] = [];
let dgHome: string | undefined;

afterEach(() => {
	closeSockets(sockets);
	if (dgHome) {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	}
	dgHome = undefined;
});

async function boot() {
	const started = await startWithSession();
	dgHome = started.dgHome;
	const cli = await connectCli(started.port, started.bootstrap);
	sockets.push(cli);
	return { ...started, cli, results: collectFrames(cli) };
}

async function extension(
	port: number,
	credentials: { sessionId: string; token: string },
	options: { version?: string } = { version: "1.22.0" },
) {
	const socket = wsExtensionSocket(port);
	sockets.push(socket);
	const frames = collectFrames(socket);
	await waitForOpen(socket);
	send(socket, {
		type: "connect",
		...credentials,
		extensionVersion: options.version,
	});
	await waitForValue(
		() => frames.find((frame) => frameType(frame) === "session-list"),
		700,
		"authenticated extension handshake",
	);
	return { socket, frames };
}

function requestApproval(cli: WebSocket, overrides: Record<string, unknown> = {}) {
	const frame = {
		type: "cli-inbox-request",
		requestId: randomUUID(),
		operation: "send-approval",
		approval: inboxSendApproval(),
		timeoutMs: 1000,
		...overrides,
	};
	send(cli, frame);
	return frame.requestId;
}

function result(frames: unknown[], requestId: string, timeoutMs = 1800) {
	return waitForValue(
		() =>
			frames.find((raw) => {
				const frame = raw as InboxResult;
				return (
					frame.type === "cli-inbox-result" && frame.requestId === requestId
				);
			}) as InboxResult | undefined,
		timeoutMs,
		`inbox result ${requestId}`,
	);
}

function relay(frames: unknown[], requestId: string) {
	return waitForValue(
		() =>
			frames.find((raw) => {
				const frame = raw as ApprovalRequestFrame;
				return (
					frame.type === "inbox-send-approval-request" &&
					frame.requestId === requestId
				);
			}) as ApprovalRequestFrame | undefined,
		700,
		`extension send-approval request ${requestId}`,
	);
}

function errorFrame(frames: unknown[]) {
	return waitForValue(
		() => frames.find((raw) => frameType(raw) === "error"),
		700,
		"error frame",
	);
}

function approve(
	socket: WebSocket,
	credentials: { sessionId: string; token: string },
	requestId: string,
	approved = true,
) {
	send(socket, {
		type: "inbox-send-approval-result",
		sessionId: credentials.sessionId,
		token: credentials.token,
		requestId,
		approved,
	});
}

describe("daemon inbox send-approval relay", () => {
	it("forwards the approval to the single ws extension peer and answers nothing until settled", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const approval = inboxSendApproval({ draftId: "m_hash_relayed" });
		const requestId = requestApproval(cli, { approval });
		const forwarded = await relay(page.frames, requestId);
		expect(forwarded.sessionId).toBe(bootstrap.sessionId);
		expect(forwarded.approval).toEqual(approval);
		expect(Object.keys(forwarded)).not.toContain("token");
		expect(JSON.stringify(forwarded)).not.toContain(bootstrap.token);
		expect(
			results.some((raw) => (raw as InboxResult).requestId === requestId),
		).toBe(false);
		approve(page.socket, bootstrap, requestId);
		const answer = await result(results, requestId);
		expect(answer).toMatchObject({
			sessionId: bootstrap.sessionId,
			requestId,
			ok: true,
			value: { approved: true },
		});
		expect(typeof (answer.value as { decidedAt: string }).decidedAt).toBe("string");
	});

	it("rejects a send-approval result from the CLI socket, keeps the request pending, and still settles from the ws peer", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = requestApproval(cli);
		await relay(page.frames, requestId);

		send(cli, {
			type: "inbox-send-approval-result",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			requestId,
			approved: true,
		});
		const rejection = await errorFrame(results);
		expect((rejection as { message: string }).message).toContain(
			"accepted only on the extension socket",
		);
		expect(
			results.some((raw) => (raw as InboxResult).requestId === requestId),
		).toBe(false);

		approve(page.socket, bootstrap, requestId, true);
		const answer = await result(results, requestId);
		expect(answer).toMatchObject({ ok: true, value: { approved: true } });
	});

	it("ignores a wrong token, an unknown requestId, a duplicate result, and a different ws socket", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const requestId = requestApproval(cli);
		await relay(selected.frames, requestId);

		const unrelated = await registerSession(port, { agentIdentity: "unrelated" });
		const outsider = await extension(port, unrelated);
		const unselected = await extension(port, bootstrap);

		approve(outsider.socket, unrelated, requestId);
		approve(unselected.socket, bootstrap, requestId);
		approve(selected.socket, bootstrap, "wrong-request-id");
		approve(
			selected.socket,
			{ sessionId: bootstrap.sessionId, token: "rejected-fixture-token" },
			requestId,
		);
		approve(selected.socket, bootstrap, requestId, true);
		expect((await result(results, requestId)).value).toMatchObject({
			approved: true,
		});

		approve(selected.socket, bootstrap, requestId, false);
		expect(
			results.filter((raw) => (raw as InboxResult).requestId === requestId),
		).toHaveLength(1);
	});

	it.each(["1.21.0", "1.21.99", undefined, "not-a-version"])(
		"rejects extension version %s with the 1.22.0 floor before forwarding",
		async (version) => {
			const { cli, results, port, bootstrap } = await boot();
			const page = await extension(port, bootstrap, { version });
			const requestId = requestApproval(cli, { timeoutMs: 30_000 });
			const answer = await result(results, requestId, 700);
			expect(answer.ok).toBe(false);
			expect(answer.error).toContain("1.22.0");
			expect(answer.error).toMatch(/update|upgrade/i);
			expect(
				page.frames.some(
					(frame) => frameType(frame) === "inbox-send-approval-request",
				),
			).toBe(false);
		},
	);

	it("names the human's dg chat tab when no extension peer is connected", async () => {
		const { cli, results, bootstrap } = await boot();
		const requestId = requestApproval(cli);
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain("Send approval needs the human's dg chat tab.");
		expect(answer.error).toContain(bootstrap.sessionId);
	});

	it("reports ambiguity, not the missing-peer text, when two extension peers are connected", async () => {
		const { cli, results, port, bootstrap } = await boot();
		await extension(port, bootstrap);
		await extension(port, bootstrap);
		const requestId = requestApproval(cli);
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/ambiguous|multiple/i);
		expect(answer.error).not.toContain("dg chat tab");
	});

	it("times out with the human-decision sentence and leaves the relay usable afterward", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const expiredId = requestApproval(cli, { timeoutMs: 100 });
		await relay(page.frames, expiredId);
		const expired = await result(results, expiredId, 700);
		expect(expired.ok).toBe(false);
		expect(expired.error).toMatch(/timed out/i);
		expect(expired.error).toMatch(/human did not decide/i);

		approve(page.socket, bootstrap, expiredId);
		expect(
			results.filter((raw) => (raw as InboxResult).requestId === expiredId),
		).toHaveLength(1);

		const nextId = requestApproval(cli);
		await relay(page.frames, nextId);
		approve(page.socket, bootstrap, nextId);
		expect((await result(results, nextId)).ok).toBe(true);
	});
});
