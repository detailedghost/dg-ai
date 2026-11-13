import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	PW_EXT_MIN_EXTENSION_VERSION,
	PW_EXT_READ_VERBS,
	PW_EXT_WRITE_VERBS,
} from "@dg/common";
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	frameType,
	killDaemonByPidFile,
	send,
	startWithSession,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

const MIN_VERSION = PW_EXT_MIN_EXTENSION_VERSION.join(".");
const [MAJOR, MINOR] = PW_EXT_MIN_EXTENSION_VERSION;
const OLDER_VERSION = `${MAJOR}.${MINOR - 1}.0`;
const VERSION_REFUSAL = `pw --ext requires dg-ai-extension ${MIN_VERSION} or newer; update the extension, reload it, and reconnect this session.`;

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
	extra: Record<string, unknown> = {},
) {
	const socket = wsExtensionSocket(port);
	sockets.push(socket);
	const frames = collectFrames(socket);
	await waitForOpen(socket);
	send(socket, { type: "connect", ...credentials, extensionVersion, ...extra });
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

	it.each([
		{ verb: "tabs" },
		{ verb: "new", url: "https://a.example/" },
		{ verb: "select", tabId: 3 },
		{ verb: "close", tabId: 3 },
		{ verb: "snapshot", tabId: 5 },
	])("forwards the tab request %p unchanged", async (verbRequest) => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { request: verbRequest });
		const forwarded = await relay(page.frames, requestId);

		expect(forwarded.request).toEqual(verbRequest);
		const data = reply(page.socket, bootstrap, requestId);
		expect(await result(results, requestId)).toMatchObject({ ok: true, data });
	});

	it("refuses a request on a session whose extension is older than the floor", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap, OLDER_VERSION);
		const requestId = request(cli);

		expect(await result(results, requestId)).toMatchObject({
			ok: false,
			error: VERSION_REFUSAL,
		});
		expect(
			page.frames.some((frame) => frameType(frame) === "pw-ext-browser-request"),
		).toBe(false);
	});

	it("refuses count at once when the extension does not list it", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { request: { verb: "count", target: "#q" } });

		expect(await result(results, requestId)).toMatchObject({
			ok: false,
			error: "pw --ext count needs a newer dg-ai-extension; update the extension, reload it, and reconnect this session.",
		});
		expect(
			page.frames.some((frame) => frameType(frame) === "pw-ext-browser-request"),
		).toBe(false);
	});

	it("refuses unmask at once when the extension lists verbs without it", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap, MIN_VERSION, {
			pwExtVerbs: [...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS].filter(
				(verb) => verb !== "unmask",
			),
		});
		const requestId = request(cli, { request: { verb: "unmask", minutes: 15 } });

		expect(await result(results, requestId)).toMatchObject({
			ok: false,
			error: "pw --ext unmask needs a newer dg-ai-extension; update the extension, reload it, and reconnect this session.",
		});
		expect(
			page.frames.some((frame) => frameType(frame) === "pw-ext-browser-request"),
		).toBe(false);
	});

	it("refuses unmask at once when the extension lists no verbs", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli, { request: { verb: "unmask", off: true } });

		expect(await result(results, requestId)).toMatchObject({
			ok: false,
			error: "pw --ext unmask needs a newer dg-ai-extension; update the extension, reload it, and reconnect this session.",
		});
		expect(
			page.frames.some((frame) => frameType(frame) === "pw-ext-browser-request"),
		).toBe(false);
	});

	it("refuses dialog at once when the extension lists verbs without it", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap, MIN_VERSION, {
			pwExtVerbs: [...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS].filter((verb) => verb !== "dialog"),
		});
		const requestId = request(cli, { request: { verb: "dialog", answer: "dismiss" } });

		expect(await result(results, requestId)).toMatchObject({
			ok: false,
			error: "pw --ext dialog needs a newer dg-ai-extension; update the extension, reload it, and reconnect this session.",
		});
		expect(page.frames.some((frame) => frameType(frame) === "pw-ext-browser-request")).toBe(false);
	});

	it("forwards count when the extension lists it", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap, MIN_VERSION, {
			pwExtVerbs: [...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS],
		});
		const requestId = request(cli, { request: { verb: "count", target: "#q" } });
		const forwarded = await relay(page.frames, requestId);

		expect(forwarded.request).toEqual({ verb: "count", target: "#q" });
		const data = reply(page.socket, bootstrap, requestId);
		expect(await result(results, requestId)).toMatchObject({ ok: true, data });
	});

	it("keeps forwarding the older verbs to an extension that lists none", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap);
		const requestId = request(cli);
		await relay(page.frames, requestId);
		const data = reply(page.socket, bootstrap, requestId);
		expect(await result(results, requestId)).toMatchObject({ ok: true, data });
	});

	it("still forwards a proto request on a session whose extension is older than the pw-ext floor", async () => {
		const { cli, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap, OLDER_VERSION);
		const requestId = randomUUID();
		send(cli, {
			type: "cli-proto-request",
			requestId,
			phase: "scrape",
			slug: "account-summary-1a2b3c4d",
			markedUrl: "https://example.test/account#_proto=fixture",
			timeoutMs: 1000,
		});

		const forwarded = await waitForValue(
			() =>
				page.frames.find(
					(frame) =>
						frameType(frame) === "proto-browser-request" &&
						(frame as { requestId?: string }).requestId === requestId,
				),
			700,
			"proto request forwarded to the older extension",
		);
		expect(forwarded).toBeDefined();
	});

	it("serves a request on a session whose extension is exactly the floor", async () => {
		const { cli, results, port, bootstrap } = await boot();
		const page = await extension(port, bootstrap, MIN_VERSION);
		const requestId = request(cli);
		await relay(page.frames, requestId);
		const data = reply(page.socket, bootstrap, requestId);

		expect(await result(results, requestId)).toMatchObject({ ok: true, data });
	});
});
