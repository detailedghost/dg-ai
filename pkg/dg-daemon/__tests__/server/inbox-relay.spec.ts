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
	registerSession,
	send,
	startWithSession,
	waitForClose,
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
	options: { version?: string } = { version: "1.10.0" },
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
	it.each([
		undefined,
		"1.9.0",
		"1.9.99",
		"not-a-version",
		"1.10",
		"1.10.0-rc.1",
		"1.10.0evil",
		"01.10.0",
	])(
		"rejects unsupported extension version %s before forwarding or waiting for browser work",
		async (version) => {
			const { cli, results, port, bootstrap } = await boot();
			const page = await extension(port, bootstrap, { version });
			const requestId = request(cli, { timeoutMs: 30_000 });
			const answer = await result(results, requestId, 700);
			expect(answer).toMatchObject({
				sessionId: bootstrap.sessionId,
				requestId,
				ok: false,
			});
			expect(answer.error).toMatch(/updat(e|ing)|upgrade/i);
			expect(answer.error).toMatch(/extension/i);
			expect(answer.error).toContain("1.10.0");
			expect(
				page.frames.some(
					(frame) => frameType(frame) === "inbox-browser-request",
				),
			).toBe(false);
		},
	);

	it.each(["1.10.0", "1.10.1", "1.11.0", "1.10.0+local.1", "2.0.0"])(
		"routes browser work through authenticated supported extension version %s",
		async (version) => {
			const { cli, results, port, bootstrap } = await boot();
			const page = await extension(port, bootstrap, { version });
			const requestId = request(cli, {
				request: { operation: "list-folders" },
			});
			expect((await relay(page.frames, requestId)).sessionId).toBe(
				bootstrap.sessionId,
			);
			const data = reply(page.socket, bootstrap, requestId);
			expect(await result(results, requestId)).toMatchObject({
				sessionId: bootstrap.sessionId,
				requestId,
				ok: true,
				value: data,
			});
		},
	);

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

	it.each([0, 2])(
		"refuses %i authorized extension peers without broadcasting a browser operation",
		async (count) => {
			const { cli, results, port, bootstrap } = await boot();
			const pages = [];
			for (let i = 0; i < count; i++)
				pages.push(await extension(port, bootstrap));
			const requestId = request(cli);
			const answer = await result(results, requestId);
			expect(answer.ok).toBe(false);
			expect(answer.error).toMatch(
				count ? /ambiguous|multiple|more than one/i : /extension|connect/i,
			);
			for (const page of pages)
				expect(
					page.frames.some(
						(frame) => frameType(frame) === "inbox-browser-request",
					),
				).toBe(false);
		},
	);

	it("ignores the wrong request, wrong session, and a newly connected unselected socket", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const requestId = request(cli, { request: { operation: "list-folders" } });
		await relay(selected.frames, requestId);
		const unrelated = await registerSession(port, {
			agentIdentity: "unrelated",
		});
		const outsider = await extension(port, unrelated);
		const unselected = await extension(port, bootstrap);
		const forged = { folders: [{ id: "forged", name: "Wrong peer" }] };
		reply(outsider.socket, unrelated, requestId, forged);
		reply(unselected.socket, bootstrap, requestId, forged);
		reply(selected.socket, bootstrap, "wrong-request-id", forged);
		reply(
			selected.socket,
			{ sessionId: bootstrap.sessionId, token: "rejected-fixture-token" },
			requestId,
			forged,
		);
		const data = reply(selected.socket, bootstrap, requestId);
		expect((await result(results, requestId)).value).toEqual(data);
		expect(
			results.filter((raw) => (raw as InboxResult).requestId === requestId),
		).toHaveLength(1);
	});

	it("does not deliver duplicate replies or let them satisfy a later request", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const firstId = request(cli, { request: { operation: "list-folders" } });
		await relay(selected.frames, firstId);
		reply(selected.socket, bootstrap, firstId);
		expect((await result(results, firstId)).ok).toBe(true);
		reply(selected.socket, bootstrap, firstId);
		const secondId = request(cli, { request: { operation: "list-folders" } });
		await relay(selected.frames, secondId);
		const data = reply(selected.socket, bootstrap, secondId, {
			folders: [{ id: "second", name: "Second request" }],
		});
		expect((await result(results, secondId)).value).toEqual(data);
		expect(
			results.filter((raw) => (raw as InboxResult).requestId === firstId),
		).toHaveLength(1);
	});

	it("returns a bounded provider failure directly while keeping the relay usable", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const requestId = request(cli);
		await relay(selected.frames, requestId);
		const error = "Proton authentication expired; sign in and retry.";
		send(selected.socket, {
			type: "inbox-browser-result",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			requestId,
			ok: false,
			error,
		});
		expect(await result(results, requestId)).toMatchObject({
			ok: false,
			error,
		});
		const nextId = request(cli, { request: { operation: "list-folders" } });
		await relay(selected.frames, nextId);
		reply(selected.socket, bootstrap, nextId);
		expect((await result(results, nextId)).ok).toBe(true);
	});

	it("expires a bounded request and ignores its late reply while accepting subsequent work", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const expiredId = request(cli, { timeoutMs: 100 });
		await relay(selected.frames, expiredId);
		const expired = await result(results, expiredId);
		expect(expired.ok).toBe(false);
		expect(expired.error).toMatch(/timeout|timed out/i);
		reply(selected.socket, bootstrap, expiredId);
		const nextId = request(cli, { request: { operation: "list-folders" } });
		await relay(selected.frames, nextId);
		reply(selected.socket, bootstrap, nextId);
		expect((await result(results, nextId)).ok).toBe(true);
		expect(
			results.filter((raw) => (raw as InboxResult).requestId === expiredId),
		).toHaveLength(1);
	});

	it("returns an actionable failure when the selected extension disconnects", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const requestId = request(cli);
		await relay(selected.frames, requestId);
		selected.socket.close();
		const answer = await result(results, requestId, 700);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/disconnect|closed/i);
	});

	it("abandons a disconnected requester without routing its late result to another CLI", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const abandonedId = request(cli);
		await relay(selected.frames, abandonedId);
		const closed = waitForClose(cli);
		cli.close();
		await closed;
		const nextCli = await connectCli(port, bootstrap);
		sockets.push(nextCli);
		const nextResults = collectFrames(nextCli);
		reply(selected.socket, bootstrap, abandonedId);
		const nextId = request(nextCli, { request: { operation: "list-folders" } });
		await relay(selected.frames, nextId);
		reply(selected.socket, bootstrap, nextId);
		expect((await result(nextResults, nextId)).ok).toBe(true);
		expect(
			nextResults.some((raw) => (raw as InboxResult).requestId === abandonedId),
		).toBe(false);
		expect(
			results.some((raw) => (raw as InboxResult).requestId === abandonedId),
		).toBe(false);
	});
});
