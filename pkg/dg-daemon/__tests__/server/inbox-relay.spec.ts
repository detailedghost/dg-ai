import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	inboxBrowserRequest,
	inboxProfile,
} from "../../../common/__tests__/utils/inbox-fixtures";
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	wsExtensionSocket,
	waitForOpen,
	frameType,
	killDaemonByPidFile,
	recvMessage,
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
type RelayFrame = {
	type: string;
	sessionId: string;
	requestId: string;
	request: unknown;
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
) {
	const socket = wsExtensionSocket(port);
	sockets.push(socket);
	const frames = collectFrames(socket);
	await waitForOpen(socket);
	send(socket, {
		type: "connect",
		...credentials,
		extensionVersion: "1.11.0",
	});
	await waitForValue(
		() => frames.find((frame) => frameType(frame) === "session-list"),
		700,
		"authenticated extension handshake",
	);
	return { socket, frames };
}

function request(cli: WebSocket, overrides: Record<string, unknown> = {}) {
	const frame = {
		type: "cli-inbox-request",
		requestId: randomUUID(),
		operation: "browser",
		request: inboxBrowserRequest(),
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
				const frame = raw as RelayFrame;
				return (
					frame.type === "inbox-browser-request" &&
					frame.requestId === requestId
				);
			}) as RelayFrame | undefined,
		700,
		`extension request ${requestId}`,
	);
}

function reply(
	socket: WebSocket,
	credentials: { sessionId: string; token: string },
	requestId: string,
	data = { folders: [{ id: "folder-a", name: "Reviewed" }] },
) {
	send(socket, {
		type: "inbox-browser-result",
		sessionId: credentials.sessionId,
		token: credentials.token,
		requestId,
		ok: true,
		data,
	});
	return data;
}

describe("daemon inbox profile operations", () => {
	it("stores configuration and caches through authenticated CLI while list output omits secrets", async () => {
		const { cli, results, bootstrap } = await boot();
		const profile = inboxProfile();
		const writeId = request(cli, {
			operation: "profile-set",
			request: undefined,
			name: "personal",
			profile,
		});
		expect((await result(results, writeId)).ok).toBe(true);
		const cache = "sensitive-oauth-fixture-58a4ab";
		const cacheWrite = request(cli, {
			operation: "cache-set",
			request: undefined,
			name: "personal",
			provider: "gmail",
			cache,
		});
		expect((await result(results, cacheWrite)).ok).toBe(true);
		const cacheRead = request(cli, {
			operation: "cache-get",
			request: undefined,
			name: "personal",
			provider: "gmail",
		});
		expect((await result(results, cacheRead)).value).toBe(cache);
		const readId = request(cli, {
			operation: "profile-get",
			request: undefined,
			name: "personal",
		});
		const read = await result(results, readId);
		expect(read.sessionId).toBe(bootstrap.sessionId);
		expect(read.value).toEqual(profile);
		const listId = request(cli, {
			operation: "profile-list",
			request: undefined,
		});
		const list = await result(results, listId);
		expect(list.value).toEqual([
			{ name: "personal", provider: profile.provider },
		]);
		expect(JSON.stringify(list)).not.toContain(cache);
	});
});

describe("daemon inbox browser relay", () => {
	it("returns one correlated extension result directly to its requesting CLI without adding a user message", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const otherCli = await connectCli(port, bootstrap);
		sockets.push(otherCli);
		const otherResults = collectFrames(otherCli);
		const requestId = request(cli, { request: { operation: "list-folders" } });
		const forwarded = await relay(page.frames, requestId);
		expect(forwarded.sessionId).toBe(bootstrap.sessionId);
		expect(forwarded.request).toEqual({ operation: "list-folders" });
		const data = reply(page.socket, bootstrap, requestId);
		const answer = await result(results, requestId);
		expect(answer).toMatchObject({
			sessionId: bootstrap.sessionId,
			requestId,
			ok: true,
			value: data,
		});
		expect(
			otherResults.some((frame) => frameType(frame) === "cli-inbox-result"),
		).toBe(false);
		expect(
			(await recvMessage(dgHome!, port, bootstrap.sessionId)).outcome,
		).toBe("empty");
	});
});
