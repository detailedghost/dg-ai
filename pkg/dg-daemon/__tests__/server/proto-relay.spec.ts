import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
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

type ProtoResult = {
	type: string;
	sessionId: string;
	requestId: string;
	ok: boolean;
};
type RelayFrame = {
	type: string;
	sessionId: string;
	requestId: string;
	phase: string;
	markedUrl: string;
	timeoutMs?: number;
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

function request(cli: WebSocket) {
	const frame = {
		type: "cli-proto-request",
		requestId: randomUUID(),
		phase: "scrape",
		slug: "account-summary-1a2b3c4d",
		markedUrl: "https://example.test/account#_proto=fixture",
		timeoutMs: 1000,
	};
	send(cli, frame);
	return frame.requestId;
}

function result(frames: unknown[], requestId: string) {
	return waitForValue(
		() =>
			frames.find((raw) => {
				const frame = raw as ProtoResult;
				return (
					frame.type === "cli-proto-result" && frame.requestId === requestId
				);
			}) as ProtoResult | undefined,
		1800,
		`proto result ${requestId}`,
	);
}

function relay(frames: unknown[], requestId: string) {
	return waitForValue(
		() =>
			frames.find((raw) => {
				const frame = raw as RelayFrame;
				return (
					frame.type === "proto-browser-request" &&
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
) {
	const data = { kind: "style-guide", styleGuide };
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
		expect(forwarded.markedUrl).toBe(
			"https://example.test/account#_proto=fixture",
		);
		expect(forwarded.timeoutMs).toBe(1000);
		const data = reply(page.socket, bootstrap, requestId);
		expect(await result(results, requestId)).toMatchObject({
			sessionId: bootstrap.sessionId,
			requestId,
			ok: true,
			data,
		});
		expect(
			(await recvMessage(dgHome!, port, bootstrap.sessionId)).outcome,
		).toBe("empty");
	});
});
