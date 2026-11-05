import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	PW_EXT_MIN_EXTENSION_VERSION,
} from "@dg/common";

const MIN_VERSION = PW_EXT_MIN_EXTENSION_VERSION.join(".");
const [MAJOR, MINOR] = PW_EXT_MIN_EXTENSION_VERSION;
const OLDER_VERSION =
	MINOR > 0 ? `${MAJOR}.${MINOR - 1}.99` : `${MAJOR - 1}.999.999`;
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	frameType,
	killDaemonByPidFile,
	registerSession,
	send,
	startWithSession,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

type CliResult = {
	type: string;
	sessionId: string;
	requestId: string;
	ok: boolean;
	data?: unknown;
	error?: string;
};
type RelayFrame = {
	type: string;
	sessionId: string;
	requestId: string;
	request: unknown;
	timeoutMs: number;
};
type Credentials = { sessionId: string; token: string };

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
	credentials: Credentials,
	extensionVersion = MIN_VERSION,
) {
	const socket = wsExtensionSocket(port);
	sockets.push(socket);
	const frames = collectFrames(socket);
	await waitForOpen(socket);
	send(socket, { type: "connect", ...credentials, extensionVersion });
	await waitForValue(
		() => frames.find((frame) => frameType(frame) === "session-list"),
		700,
		"authenticated extension handshake",
	);
	return { socket, frames };
}

function request(
	cli: WebSocket,
	overrides: Record<string, unknown> = {},
): string {
	const frame = {
		type: "cli-pw-ext-request",
		requestId: randomUUID(),
		request: { verb: "current" },
		timeoutMs: 1000,
		...overrides,
	};
	send(cli, frame);
	return frame.requestId as string;
}

function result(frames: unknown[], requestId: string, timeoutMs = 1800) {
	return waitForValue(
		() =>
			frames.find((raw) => {
				const frame = raw as CliResult;
				return (
					frame.type === "cli-pw-ext-result" && frame.requestId === requestId
				);
			}) as CliResult | undefined,
		timeoutMs,
		`pw-ext result ${requestId}`,
	);
}

function relay(frames: unknown[], requestId: string) {
	return waitForValue(
		() =>
			frames.find((raw) => {
				const frame = raw as RelayFrame;
				return (
					frame.type === "pw-ext-browser-request" &&
					frame.requestId === requestId
				);
			}) as RelayFrame | undefined,
		700,
		`extension request ${requestId}`,
	);
}

function reply(
	socket: WebSocket,
	credentials: Credentials,
	requestId: string,
	data: unknown = { text: "### Page" },
) {
	send(socket, {
		type: "pw-ext-browser-result",
		sessionId: credentials.sessionId,
		token: credentials.token,
		requestId,
		ok: true,
		data,
	});
	return data;
}

describe("daemon pw --ext relay", () => {
	it("routes a verb through the paired extension back to its CLI", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, {
			request: { verb: "click", target: "e4" },
		});
		const forwarded = await relay(page.frames, requestId);
		expect(forwarded).toMatchObject({
			sessionId: bootstrap.sessionId,
			request: { verb: "click", target: "e4" },
			timeoutMs: 1000,
		});
		const data = reply(page.socket, bootstrap, requestId);
		expect(await result(results, requestId)).toMatchObject({
			sessionId: bootstrap.sessionId,
			ok: true,
			data,
		});
	});

	it("refuses an unsupported verb before it reaches the extension", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, {
			request: { verb: "eval", code: "document.cookie" },
		});
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/verb/);
		expect(
			page.frames.some((frame) => frameType(frame) === "pw-ext-browser-request"),
		).toBe(false);
	});

	it("refuses an extension that predates pw --ext", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap, OLDER_VERSION);
		const requestId = request(cli);
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toContain(MIN_VERSION);
		expect(
			page.frames.some((frame) => frameType(frame) === "pw-ext-browser-request"),
		).toBe(false);
	});

	it("refuses zero or several extension peers", async () => {
		for (const count of [0, 2]) {
			const { cli, results, port, bootstrap } = await boot();
			for (let i = 0; i < count; i++) await extension(port, bootstrap);
			const requestId = request(cli);
			const answer = await result(results, requestId);
			expect(answer.ok).toBe(false);
			expect(answer.error).toMatch(
				count ? /ambiguous/i : /No extension peer/,
			);
			killDaemonByPidFile(dgHome!);
			cleanupDgHome(dgHome!);
			dgHome = undefined;
			closeSockets(sockets);
		}
	});

	it("times out with a hint that the approval may still be open", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { timeoutMs: 150 });
		await relay(page.frames, requestId);
		const answer = await result(results, requestId, 2000);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/timed out/i);
		expect(answer.error).toMatch(/approval/i);
	});

	it("ignores replies from other sessions, other sockets, and forged tokens", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const selected = await extension(port, bootstrap);
		const requestId = request(cli);
		await relay(selected.frames, requestId);
		const unrelated = await registerSession(port, { agentIdentity: "other" });
		const outsider = await extension(port, unrelated);
		reply(outsider.socket, unrelated, requestId, { text: "forged" });
		reply(
			selected.socket,
			{ sessionId: bootstrap.sessionId, token: "forged-token" },
			requestId,
			{ text: "forged" },
		);
		const data = reply(selected.socket, bootstrap, requestId);
		expect((await result(results, requestId)).data).toEqual(data);
		expect(
			results.filter((raw) => (raw as CliResult).requestId === requestId),
		).toHaveLength(1);
	});

	it("settles the CLI when the extension result is invalid", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { timeoutMs: 5000 });
		await relay(page.frames, requestId);
		reply(page.socket, bootstrap, requestId, { text: "x", cookies: "a=b" });
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/could not be delivered/);
	});

	it("settles the CLI when the extension result exceeds the frame limit", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, {
			request: { verb: "screenshot" },
			timeoutMs: 5000,
		});
		await relay(page.frames, requestId);
		page.socket.send(
			JSON.stringify({
				type: "pw-ext-browser-result",
				sessionId: bootstrap.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				token: bootstrap.token,
				requestId,
				ok: true,
				data: {
					text: "x",
					image: `data:image/png;base64,${"A".repeat(CHAT_MAX_PAYLOAD_BYTES)}`,
				},
			}),
		);
		const answer = await result(results, requestId);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/size limit/);
	});

	it("refuses a reused requestId so a late reply cannot settle a new call", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { timeoutMs: 100 });
		await relay(page.frames, requestId);
		expect((await result(results, requestId, 2000)).error).toMatch(/timed out/);
		const other = await connectCli(port, bootstrap);
		sockets.push(other);
		const otherResults = collectFrames(other);
		request(other, { requestId, request: { verb: "click", target: "e1" } });
		const reused = await result(otherResults, requestId);
		expect(reused.ok).toBe(false);
		expect(reused.error).toMatch(/already used/);
		reply(page.socket, bootstrap, requestId, { text: "old snapshot result" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(
			otherResults.filter((raw) => (raw as CliResult).requestId === requestId),
		).toHaveLength(1);
	});

	it("forwards a cancel from the requesting CLI to the extension", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { timeoutMs: 5000 });
		await relay(page.frames, requestId);
		send(cli, { type: "cli-pw-ext-cancel", requestId });
		const cancel = await waitForValue(
			() =>
				page.frames.find(
					(raw) =>
						frameType(raw) === "pw-ext-browser-cancel" &&
						(raw as RelayFrame).requestId === requestId,
				),
			700,
			"extension cancel",
		);
		expect(cancel).toMatchObject({ sessionId: bootstrap.sessionId });
		reply(page.socket, bootstrap, requestId);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(
			results.filter((raw) => (raw as CliResult).type === "cli-pw-ext-result"),
		).toHaveLength(0);
	});

	it("ignores a cancel from a CLI that did not send the request", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { timeoutMs: 5000 });
		await relay(page.frames, requestId);
		const other = await connectCli(port, bootstrap);
		sockets.push(other);
		send(other, { type: "cli-pw-ext-cancel", requestId });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(
			page.frames.some((raw) => frameType(raw) === "pw-ext-browser-cancel"),
		).toBe(false);
		reply(page.socket, bootstrap, requestId);
		expect((await result(results, requestId)).ok).toBe(true);
	});

	it("tells the extension to cancel when the requesting CLI disconnects", async () => {
		const { cli, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { timeoutMs: 5000 });
		await relay(page.frames, requestId);
		cli.close();
		await waitForValue(
			() =>
				page.frames.find(
					(raw) =>
						frameType(raw) === "pw-ext-browser-cancel" &&
						(raw as RelayFrame).requestId === requestId,
				),
			1500,
			"extension cancel after disconnect",
		);
	});

	it("fails the request when the extension disconnects", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli);
		await relay(page.frames, requestId);
		page.socket.close();
		const answer = await result(results, requestId, 700);
		expect(answer.ok).toBe(false);
		expect(answer.error).toMatch(/disconnect/i);
	});
});
