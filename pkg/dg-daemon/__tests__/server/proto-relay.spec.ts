import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { CHAT_MAX_PAYLOAD_BYTES, CHAT_PROTOCOL_VERSION } from "@dg/common";
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

type ProtoResult = {
	type: string;
	sessionId: string;
	requestId: string;
	ok: boolean;
	data?: unknown;
	notReady?: unknown;
	error?: string;
};
type RelayFrame = {
	type: string;
	sessionId: string;
	requestId: string;
	phase: string;
	slug: string;
	markedUrl: string;
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

async function extension(port: number, credentials: { sessionId: string; token: string }) {
	const socket = wsExtensionSocket(port);
	sockets.push(socket);
	const frames = collectFrames(socket);
	await waitForOpen(socket);
	send(socket, { type: "connect", ...credentials, extensionVersion: "1.19.1" });
	await waitForValue(
		() => frames.find((frame) => frameType(frame) === "session-list"),
		700,
		"authenticated extension handshake",
	);
	return { socket, frames };
}

const styleGuide = {
	meta: { url: "https://example.test/account", scrapedAt: 1, sameOrigin: true },
	tokens: {
		customProps: {},
		colors: ["rgb(0, 0, 0)"],
		fontStack: "sans-serif",
		typeScale: [],
		spacing: [],
		radii: [],
		shadows: [],
	},
	components: { button: {}, input: {}, link: {} },
};

function request(cli: WebSocket, overrides: Record<string, unknown> = {}) {
	const frame = {
		type: "cli-proto-request",
		requestId: randomUUID(),
		phase: "scrape",
		slug: "account-summary-1a2b3c4d",
		markedUrl: "https://example.test/account#_proto=fixture",
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
				const frame = raw as ProtoResult;
				return frame.type === "cli-proto-result" && frame.requestId === requestId;
			}) as ProtoResult | undefined,
		timeoutMs,
		`proto result ${requestId}`,
	);
}

function relay(frames: unknown[], requestId: string) {
	return waitForValue(
		() =>
			frames.find((raw) => {
				const frame = raw as RelayFrame;
				return frame.type === "proto-browser-request" && frame.requestId === requestId;
			}) as RelayFrame | undefined,
		700,
		`extension request ${requestId}`,
	);
}

function reply(
	socket: WebSocket,
	credentials: { sessionId: string; token: string },
	requestId: string,
	data: unknown = { kind: "style-guide", styleGuide },
) {
	send(socket, {
		type: "proto-browser-result",
		sessionId: credentials.sessionId,
		token: credentials.token,
		requestId,
		ok: true,
		data,
	});
	return data;
}

describe("daemon prototype browser relay", () => {
	it("routes a scrape request through the paired extension to its requesting CLI", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli);
		const forwarded = await relay(page.frames, requestId);
		expect(forwarded.sessionId).toBe(bootstrap.sessionId);
		expect(forwarded.phase).toBe("scrape");
		expect(forwarded.markedUrl).toBe("https://example.test/account#_proto=fixture");
		const data = reply(page.socket, bootstrap, requestId);
		expect(await result(results, requestId)).toMatchObject({
			sessionId: bootstrap.sessionId,
			requestId,
			ok: true,
			data,
		});
	});

	it("returns a typed not-ready error without touching the generic error field", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { phase: "plant" });
		await relay(page.frames, requestId);
		const notReady = {
			code: "login-page",
			message: "the page requires sign-in",
			landedUrl: "https://example.test/login",
		};
		send(page.socket, {
			type: "proto-browser-result",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			requestId,
			ok: false,
			notReady,
		});
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(false);
		expect(answer.notReady).toEqual(notReady);
		expect(answer.error).toBeUndefined();
	});

	it("refuses zero or several authorized extension peers without broadcasting a browser request", async () => {
		for (const count of [0, 2]) {
			const { cli, results, port, bootstrap } = await boot();
			const pages = [];
			for (let i = 0; i < count; i++) pages.push(await extension(port, bootstrap));
			const requestId = request(cli);
			const answer = await result(results, requestId);
			expect(answer.ok).toBe(false);
			expect(answer.error).toMatch(count ? /ambiguous|multiple/i : /extension|connect/i);
			if (count === 0) {
				expect(answer.error).toContain(`No extension peer on session ${bootstrap.sessionId}`);
				expect(answer.error).toContain("/start#_chat=");
				expect(answer.error).toContain("dg-skills inbox bootstrap-url");
			}
			for (const page of pages) {
				expect(page.frames.some((frame) => frameType(frame) === "proto-browser-request")).toBe(
					false,
				);
			}
			killDaemonByPidFile(dgHome!);
			cleanupDgHome(dgHome!);
			dgHome = undefined;
			closeSockets(sockets);
		}
	});

	it("reports the extension's last progress report in the timeout message", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { phase: "plant", timeoutMs: 150 });
		await relay(page.frames, requestId);
		send(page.socket, {
			type: "proto-browser-progress",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			requestId,
			status: "planted; awaiting your approve/reject in the browser",
		});
		const answer = await result(results, requestId, 2000);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/timed out/i);
		expect(answer.error).toContain(
			"planted; awaiting your approve/reject in the browser",
		);
	});

	it("names no report from the extension when a timeout carries no progress", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { timeoutMs: 150 });
		await relay(page.frames, requestId);
		const answer = await result(results, requestId, 2000);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/timed out/i);
		expect(answer.error).toMatch(/no report from the extension/i);
		expect(answer.error).toContain("https://example.test/account");
		expect(answer.error).not.toContain("#_proto=");
		expect(answer.error).not.toContain("fixture");
	});

	it("rejects a duplicate requestId from a different CLI without replacing the original", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { timeoutMs: 5_000 });
		await relay(page.frames, requestId);
		const other = await connectCli(port, bootstrap);
		sockets.push(other);
		const otherResults = collectFrames(other);
		send(other, {
			type: "cli-proto-request",
			requestId,
			phase: "scrape",
			slug: "account-summary-1a2b3c4d",
			markedUrl: "https://example.test/account#_proto=other",
			timeoutMs: 5_000,
		});
		const rejected = await result(otherResults, requestId);
		expect(rejected).toMatchObject({
			ok: false,
			error: "duplicate requestId",
		});
		const data = reply(page.socket, bootstrap, requestId);
		expect(await result(results, requestId)).toMatchObject({
			ok: true,
			data,
		});
	});

	it("delivers a verdict when the preview makes the result exceed the frame limit", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { phase: "plant", timeoutMs: 5_000 });
		await relay(page.frames, requestId);
		const verdict = {
			slug: "account-summary-1a2b3c4d",
			action: "approve",
			selectedKey: "compact",
			ts: 1,
		};
		const previewDataUrl = `data:image/png;base64,${"A".repeat(CHAT_MAX_PAYLOAD_BYTES)}`;
		const payload = JSON.stringify({
			type: "proto-browser-result",
			sessionId: bootstrap.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			token: bootstrap.token,
			requestId,
			ok: true,
			data: { kind: "verdict", verdict, previewDataUrl },
		});
		expect(Buffer.byteLength(payload)).toBeGreaterThan(CHAT_MAX_PAYLOAD_BYTES);
		expect(Buffer.byteLength(payload)).toBeLessThan(CHAT_MAX_PAYLOAD_BYTES + 4096);
		page.socket.send(payload);
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(true);
		expect(answer.error).toBeUndefined();
		expect(answer.data).toEqual({ kind: "verdict", verdict });
	});

	it("ignores the wrong request, wrong session, and a newly connected unselected socket", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const requestId = request(cli);
		await relay(selected.frames, requestId);
		const unrelated = await registerSession(port, { agentIdentity: "unrelated" });
		const outsider = await extension(port, unrelated);
		const unselected = await extension(port, bootstrap);
		const forged = { kind: "style-guide", styleGuide };
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
		expect((await result(results, requestId)).data).toEqual(data);
		expect(results.filter((raw) => (raw as ProtoResult).requestId === requestId)).toHaveLength(1);
	});

	it("expires a bounded request and ignores its late reply while accepting subsequent work", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const expiredId = request(cli, { timeoutMs: 100 });
		await relay(selected.frames, expiredId);
		const expired = await result(results, expiredId);
		expect(expired.ok).toBe(false);
		expect(expired.error).toMatch(/timed out/i);
		reply(selected.socket, bootstrap, expiredId);
		const nextId = request(cli);
		await relay(selected.frames, nextId);
		reply(selected.socket, bootstrap, nextId);
		expect((await result(results, nextId)).ok).toBe(true);
		expect(results.filter((raw) => (raw as ProtoResult).requestId === expiredId)).toHaveLength(1);
	});

	it("returns an actionable failure when the selected extension disconnects", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const requestId = request(cli);
		await relay(selected.frames, requestId);
		selected.socket.close();
		const answer = await result(results, requestId, 700);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/disconnect/i);
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
		const nextId = request(nextCli);
		await relay(selected.frames, nextId);
		reply(selected.socket, bootstrap, nextId);
		expect((await result(nextResults, nextId)).ok).toBe(true);
		expect(nextResults.some((raw) => (raw as ProtoResult).requestId === abandonedId)).toBe(false);
		expect(results.some((raw) => (raw as ProtoResult).requestId === abandonedId)).toBe(false);
	});

	it("returns one correlated extension result directly to its requesting CLI without adding a user message", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const otherCli = await connectCli(port, bootstrap);
		sockets.push(otherCli);
		const otherResults = collectFrames(otherCli);
		const requestId = request(cli);
		await relay(page.frames, requestId);
		const data = reply(page.socket, bootstrap, requestId);
		const answer = await result(results, requestId);
		expect(answer).toMatchObject({ sessionId: bootstrap.sessionId, requestId, ok: true, data });
		expect(otherResults.some((frame) => frameType(frame) === "cli-proto-result")).toBe(false);
		expect((await recvMessage(dgHome!, port, bootstrap.sessionId)).outcome).toBe("empty");
	});
});
