import { afterEach, describe, expect, it, type Mock, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	PW_EXT_MIN_EXTENSION_VERSION,
	PW_EXT_RELAY,
} from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import { registerAsset } from "../../src/assets/register";
import { DispatchScheduler } from "../../src/dispatch/scheduler";
import { SessionRegistry } from "../../src/session/registry";
import {
	createBrowserRelay,
	type RelayHooks,
	type RelayOutcome,
} from "../../src/server/browser-relay";
import { pwExtRelayHooks } from "../../src/server/pw-ext";
import {
	abortPendingWork,
	ConnectionManager,
	createSocketState,
	type SocketKind,
	type SocketState,
} from "../../src/server/connection";
import {
	buildRelayRoutes,
	failUnreadableRelays,
	type FrameHandlerDeps,
	handleSocketMessage,
	settleOversizedRelays,
} from "../../src/server/frame-handlers";
import type { Logger } from "../../src/server/log";
import { ChatStore } from "../../src/store";
import type { CredentialStore } from "../../src/store/credentials-store";
import {
	TEST_RELAY,
	type TestCliRequest,
} from "../../../common/__tests__/utils/relay-fixtures";
import {
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	freshDgHome,
} from "../utils/daemon-harness";

const MIN_VERSION = PW_EXT_MIN_EXTENSION_VERSION.join(".");
const [MAJOR, MINOR] = PW_EXT_MIN_EXTENSION_VERSION;
const OLDER_VERSION = `${MAJOR}.${MINOR - 1}.99`;
const TEST_VERSION = "9.0.0";

const logger: Logger = {
	info() {},
	warn() {},
	error() {},
	getLastError: () => null,
	flush: async () => {},
};

type Sent = Mock<(payload: string) => number>;
type FakeSocket = ServerWebSocket<SocketState> & { send: Sent };
type Frame = Record<string, unknown>;

function fakeSocket(
	kind: SocketKind,
	options: {
		capabilities?: readonly (readonly [string, string])[];
		extensionVersion?: string;
		localPage?: boolean;
		send?: Sent;
	} = {},
): FakeSocket {
	const data = createSocketState(kind, logger);
	for (const [sessionId, token] of options.capabilities ?? [])
		data.capabilities.set(sessionId, token);
	data.extensionVersion = options.extensionVersion;
	data.localPage = options.localPage ?? false;
	const send = options.send ?? mock((_payload: string) => 1);
	return { data, send, close: mock(() => {}) } as unknown as FakeSocket;
}

function rejectSends(ws: FakeSocket): void {
	ws.data.enqueue = () => Promise.reject(new Error("socket write failed"));
}

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function world() {
	const dgHome = freshDgHome();
	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
	const registry = new SessionRegistry(paths);
	const connections = new ConnectionManager();
	const sockets: FakeSocket[] = [];
	cleanups.push(() => {
		for (const ws of sockets) abortPendingWork(ws);
		store.close();
		cleanupDgHome(dgHome);
	});
	const deps: FrameHandlerDeps = {
		registry,
		connections,
		logger,
		paths,
		noteActivity() {},
		store,
		credentials: {} as CredentialStore,
		dispatchScheduler: new DispatchScheduler(),
		overwatchOpenRequests: new Map(),
	};
	const session = registry.create({
		cwd: dgHome,
		agentIdentity: "agent",
		role: "agent",
	});
	const { sessionId, token } = session;
	const socket = (kind: SocketKind, options: Parameters<typeof fakeSocket>[1] = {}) => {
		const ws = fakeSocket(kind, { capabilities: [[sessionId, token]], ...options });
		connections.add(ws);
		sockets.push(ws);
		return ws;
	};
	return {
		deps,
		dgHome,
		connections,
		store,
		registry,
		sessionId,
		token,
		cli: (options?: Parameters<typeof fakeSocket>[1]) => socket("cli", options),
		extension: (extensionVersion = MIN_VERSION, options: Parameters<typeof fakeSocket>[1] = {}) =>
			socket("ws", { extensionVersion, ...options }),
		page: () => socket("ws", { localPage: true }),
		post: (ws: FakeSocket, frame: Frame) =>
			handleSocketMessage(ws, JSON.stringify(frame), deps),
		postRaw: (ws: FakeSocket, raw: string) => handleSocketMessage(ws, raw, deps),
	};
}

type World = Awaited<ReturnType<typeof world>>;

function sentFrames(ws: FakeSocket): Frame[] {
	return ws.send.mock.calls.map(([payload]) => JSON.parse(payload) as Frame);
}

function sentOfType(ws: FakeSocket, type: string): Frame[] {
	return sentFrames(ws).filter((frame) => frame.type === type);
}

async function until(predicate: () => boolean, ms = 500): Promise<void> {
	const end = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > end) throw new Error("condition not met in time");
		await Bun.sleep(5);
	}
}

async function quiet(): Promise<void> {
	await Bun.sleep(40);
}

function pwRequest(overrides: Frame = {}): Frame {
	return {
		type: "cli-pw-ext-request",
		requestId: randomUUID(),
		request: { verb: "current" },
		timeoutMs: 60_000,
		...overrides,
	};
}

function pwResult(w: World, requestId: string, overrides: Frame = {}): Frame {
	return {
		type: "pw-ext-browser-result",
		sessionId: w.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		token: w.token,
		requestId,
		ok: true,
		data: { text: "x" },
		...overrides,
	};
}

function cliResults(ws: FakeSocket): Frame[] {
	return sentOfType(ws, "cli-pw-ext-result");
}

const NO_PEER = (sessionId: string) =>
	`No extension peer on session ${sessionId}. Pair the dg-ai-extension with this session, then retry. Run dg-skills doctor pw for the steps.`;
const ALREADY_USED =
	"pw --ext requestId was already used on this session; send a new one.";
const TOO_MANY =
	"pw --ext has too many pending requests; wait for the open requests to finish.";
const ACTIVE = "pw --ext requires an active dg session.";
const MULTIPLE =
	"Multiple extension peers make the pw --ext request ambiguous; keep one extension connected to this session.";
const OLD_VERSION = `pw --ext requires dg-ai-extension ${MIN_VERSION} or newer; update the extension, reload it, and reconnect this session.`;

describe("pw-ext relay bytes", () => {
	it("sends the pinned browser request and CLI result bytes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, { type: "cli-pw-ext-request", requestId: "r-1", request: { verb: "current" } });
		expect(ext.send.mock.calls).toHaveLength(1);
		expect(ext.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "pw-ext-browser-request",
				sessionId: w.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: "r-1",
				request: { verb: "current" },
				timeoutMs: 120000,
			}),
		);
		await w.post(ext, pwResult(w, "r-1"));
		await until(() => cli.send.mock.calls.length === 1);
		expect(cli.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "cli-pw-ext-result",
				sessionId: w.sessionId,
				requestId: "r-1",
				ok: true,
				data: { text: "x" },
			}),
		);
	});

	it("sends a failed extension result as an error result", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-2" }));
		await w.post(ext, pwResult(w, "r-2", { ok: false, data: undefined, error: "tab closed" }));
		await until(() => cli.send.mock.calls.length === 1);
		expect(cli.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "cli-pw-ext-result",
				sessionId: w.sessionId,
				requestId: "r-2",
				ok: false,
				error: "tab closed",
			}),
		);
	});
});

describe("pw-ext relay check order", () => {
	it("answers the active refusal before the replay refusal", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		await w.post(ext, pwResult(w, "r-1"));
		await until(() => cliResults(cli).length === 1);
		const record = w.registry.get(w.sessionId);
		if (!record) throw new Error("session missing");
		record.state = "closed";
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		expect(cliResults(cli)[1]).toMatchObject({ ok: false, error: ACTIVE });
	});

	it("answers the cap refusal before the peers refusal", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		await w.post(cli, pwRequest());
		await w.post(cli, pwRequest());
		w.extension();
		await w.post(cli, pwRequest());
		expect(cliResults(cli)).toHaveLength(1);
		expect(cliResults(cli)[0]).toMatchObject({ ok: false, error: TOO_MANY });
	});

	it("answers the peers refusal before the version refusal", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension(OLDER_VERSION);
		w.extension(OLDER_VERSION);
		await w.post(cli, pwRequest());
		expect(cliResults(cli)[0]).toMatchObject({ ok: false, error: MULTIPLE });
	});

	it("answers the replay refusal before the session id cap on a small table", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: TEST_RELAY });
		for (const requestId of ["a", "b", "c"]) {
			await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId });
			relay.handleResult(ext, { sessionId: w.sessionId, requestId, ok: true });
		}
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "a" });
		expect(sentOfType(cli, "cli-test-result").at(-1)).toMatchObject({
			error: "test: id already used",
		});
	});

	it("answers the session id cap before the pending cap on a small table", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: TEST_RELAY });
		for (const requestId of ["a", "b"]) {
			await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId });
			relay.handleResult(ext, { sessionId: w.sessionId, requestId, ok: true });
		}
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "c" });
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "d" });
		expect(sentOfType(cli, "cli-test-result").at(-1)).toMatchObject({
			error: "test: out of ids",
		});
	});

	it("answers the duplicate refusal before the replay refusal on a small table", async () => {
		const w = await world();
		const first = w.cli();
		const second = w.cli();
		w.extension(TEST_VERSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: TEST_RELAY });
		await relay.handleRequest(first, w.sessionId, { type: "cli-test-request", requestId: "a" });
		await relay.handleRequest(second, w.sessionId, { type: "cli-test-request", requestId: "a" });
		expect(sentOfType(second, "cli-test-result")).toMatchObject([
			{ ok: false, error: "test: duplicate" },
		]);
	});

	it("drops a pending id resent by the same requester without an answer", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: TEST_RELAY });
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "a" });
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "a" });
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
		expect(sentOfType(ext, "test-browser-request")).toHaveLength(1);
	});
});

describe("pw-ext relay burn point", () => {
	it("lets a request refused for no peer be resent with the same id", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		expect(cliResults(cli)[0]).toMatchObject({ error: NO_PEER(w.sessionId) });
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		expect(sentOfType(ext, "pw-ext-browser-request")).toHaveLength(1);
	});

	it("burns the id before the version refusal", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension(OLDER_VERSION);
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		expect(cliResults(cli)[0]).toMatchObject({ error: OLD_VERSION });
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		expect(cliResults(cli)[1]).toMatchObject({ error: ALREADY_USED });
	});

	it("refuses an id reused after its request timed out", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1", timeoutMs: 20 }));
		await until(() => cliResults(cli).length === 1);
		const other = w.cli();
		await w.post(other, pwRequest({ requestId: "r-1" }));
		expect(cliResults(other)[0]).toMatchObject({ ok: false, error: ALREADY_USED });
	});
});

describe("pw-ext relay caps", () => {
	it("refuses the 17th pending request on a session with 9 requesters", async () => {
		const w = await world();
		w.extension();
		const requesters = Array.from({ length: 9 }, () => w.cli());
		for (const requester of requesters.slice(0, 8)) {
			await w.post(requester, pwRequest());
			await w.post(requester, pwRequest());
		}
		const ninth = requesters[8] as FakeSocket;
		await w.post(ninth, pwRequest());
		expect(cliResults(ninth)).toMatchObject([{ ok: false, error: TOO_MANY }]);
	});

	it("refuses the third pending request from one requester", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		await w.post(cli, pwRequest());
		await w.post(cli, pwRequest());
		await w.post(cli, pwRequest());
		expect(cliResults(cli)).toMatchObject([{ ok: false, error: TOO_MANY }]);
	});

	it("refuses the fourth id on a small table and clears the set when the session closes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: TEST_RELAY });
		for (const requestId of ["a", "b", "c"]) {
			await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId });
			relay.handleResult(ext, { sessionId: w.sessionId, requestId, ok: true });
		}
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "d" });
		expect(sentOfType(cli, "cli-test-result").at(-1)).toMatchObject({
			error: "test: out of ids",
		});
		w.deps.registry.emit("closed", { sessionId: w.sessionId, reason: "closed" });
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "e" });
		expect(sentOfType(ext, "test-browser-request").at(-1)).toMatchObject({
			requestId: "e",
		});
	});
});

describe("pw-ext relay ends", () => {
	it("cancels in the extension before it answers a timeout", async () => {
		const w = await world();
		const log: string[] = [];
		const cli = w.cli({
			send: mock((payload: string) => log.push(`cli:${JSON.parse(payload).type}`)),
		});
		w.extension(MIN_VERSION, {
			send: mock((payload: string) => log.push(`ext:${JSON.parse(payload).type}`)),
		});
		await w.post(cli, pwRequest({ requestId: "r-1", timeoutMs: 20 }));
		await until(() => log.length === 3);
		expect(log).toEqual([
			"ext:pw-ext-browser-request",
			"ext:pw-ext-browser-cancel",
			"cli:cli-pw-ext-result",
		]);
	});

	it("words the timeout and sends the cancel frame fields", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1", timeoutMs: 20 }));
		await until(() => cliResults(cli).length === 1);
		expect(sentOfType(ext, "pw-ext-browser-cancel")).toEqual([
			{
				type: "pw-ext-browser-cancel",
				sessionId: w.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: "r-1",
			},
		]);
		expect(cliResults(cli)[0]).toMatchObject({
			ok: false,
			error: "pw --ext timed out after 20ms; the extension was told to cancel it.",
		});
	});

	it("cancels in the extension and sends no result when the requester closes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		abortPendingWork(cli);
		await until(() => sentOfType(ext, "pw-ext-browser-cancel").length === 1);
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
	});

	it("answers when the extension closes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		abortPendingWork(ext);
		await until(() => cliResults(cli).length === 1);
		expect(cliResults(cli)[0]).toMatchObject({
			ok: false,
			error: "pw --ext extension disconnected before replying.",
		});
	});

	it("cancels for the requester and sends no result", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		await w.post(cli, { type: "cli-pw-ext-cancel", requestId: "r-1" });
		await until(() => sentOfType(ext, "pw-ext-browser-cancel").length === 1);
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
	});

	it("ignores a cancel from another CLI socket", async () => {
		const w = await world();
		const cli = w.cli();
		const other = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		await w.post(other, { type: "cli-pw-ext-cancel", requestId: "r-1" });
		await quiet();
		expect(sentOfType(ext, "pw-ext-browser-cancel")).toEqual([]);
		await w.post(ext, pwResult(w, "r-1"));
		await until(() => cliResults(cli).length === 1);
		expect(cliResults(cli)[0]).toMatchObject({ ok: true });
	});

	it("answers when the session closes", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		w.deps.registry.emit("closed", { sessionId: w.sessionId, reason: "closed" });
		await until(() => cliResults(cli).length === 1);
		expect(cliResults(cli)[0]).toMatchObject({
			ok: false,
			error: "pw --ext session closed before the extension replied.",
		});
	});

	it("answers when the extension send fails", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		rejectSends(ext);
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		await until(() => cliResults(cli).length === 1);
		expect(cliResults(cli)[0]).toMatchObject({
			ok: false,
			error: "pw --ext request could not be sent; reconnect the extension.",
		});
	});
});

describe("pw-ext relay result ownership", () => {
	async function pendingWorld() {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		return { w, cli, ext };
	}

	it("ignores a result from a second extension socket", async () => {
		const { w, cli } = await pendingWorld();
		const second = w.extension();
		await w.post(second, pwResult(w, "r-1", { data: { text: "forged" } }));
		await quiet();
		expect(cliResults(cli)).toEqual([]);
	});

	it("ignores a result from a page socket", async () => {
		const { w, cli } = await pendingWorld();
		const page = w.page();
		await w.post(page, pwResult(w, "r-1", { data: { text: "forged" } }));
		await quiet();
		expect(cliResults(cli)).toEqual([]);
	});

	it("ignores a result that names another session", async () => {
		const { w, cli } = await pendingWorld();
		const other = w.registry.create({
			cwd: w.dgHome,
			agentIdentity: "other",
			role: "agent",
		});
		const outsider = fakeSocket("ws", {
			extensionVersion: MIN_VERSION,
			capabilities: [[other.sessionId, other.token]],
		});
		await w.post(outsider, pwResult(w, "r-1", { token: other.token }));
		await quiet();
		expect(cliResults(cli)).toEqual([]);
	});

	it("ignores a result with a wrong token", async () => {
		const { w, cli, ext } = await pendingWorld();
		await w.post(ext, pwResult(w, "r-1", { token: "forged-token" }));
		await quiet();
		expect(cliResults(cli)).toEqual([]);
		expect(ext.data.invalidFrameCount).toBe(1);
	});

	it("ignores a second result for a settled request", async () => {
		const { w, cli, ext } = await pendingWorld();
		await w.post(ext, pwResult(w, "r-1"));
		await w.post(ext, pwResult(w, "r-1", { data: { text: "late" } }));
		await quiet();
		expect(cliResults(cli)).toHaveLength(1);
		expect(cliResults(cli)[0]).toMatchObject({ data: { text: "x" } });
	});
});

describe("pw-ext relay unreadable results", () => {
	it("settles the CLI for an oversized result and still strikes the extension", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		const raw = JSON.stringify(
			pwResult(w, "r-1", {
				data: {
					text: "x",
					image: `data:image/png;base64,${"A".repeat(CHAT_MAX_PAYLOAD_BYTES)}`,
				},
			}),
		);
		await w.postRaw(ext, raw);
		await until(() => cliResults(cli).length === 1);
		expect(cliResults(cli)[0]).toMatchObject({
			ok: false,
			error: "pw --ext result could not be delivered: it exceeded the relay size limit",
		});
		const errors = sentOfType(ext, "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe(
			`payload of ${Buffer.byteLength(raw)} bytes exceeds CHAT_MAX_PAYLOAD_BYTES (${CHAT_MAX_PAYLOAD_BYTES})`,
		);
		expect(ext.data.invalidFrameCount).toBe(1);
	});

	it("does not settle for an oversized result with a wrong token", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		const raw = JSON.stringify(
			pwResult(w, "r-1", {
				token: "forged-token",
				data: { text: "x".repeat(CHAT_MAX_PAYLOAD_BYTES) },
			}),
		);
		await w.postRaw(ext, raw);
		await quiet();
		expect(cliResults(cli)).toEqual([]);
		expect(ext.data.invalidFrameCount).toBe(1);
	});

	it("settles the CLI for an invalid result and sends the extension no error", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		await w.post(ext, pwResult(w, "r-1", { data: { text: "x", cookies: "a=b" } }));
		await until(() => cliResults(cli).length === 1);
		expect(cliResults(cli)[0]).toMatchObject({
			ok: false,
			error:
				'pw --ext result could not be delivered: pw-ext response has unknown field "cookies"',
		});
		expect(sentOfType(ext, "error")).toEqual([]);
		expect(ext.data.invalidFrameCount).toBe(0);
	});

	it("keeps a pending request waiting when the result frame is valid", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		const relay = createBrowserRelay({
			deps: w.deps,
			feature: PW_EXT_RELAY,
		});
		expect(relay.settleRejected(ext, pwResult(w, "r-1"))).toBe(false);
		await quiet();
		expect(cliResults(cli)).toEqual([]);
	});
});

describe("pw-ext relay invalid CLI frames", () => {
	it("answers an invalid request with the validator message and one strike", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, pwRequest({ requestId: "r-1", request: { verb: "jump" } }));
		expect(cliResults(cli)).toEqual([
			{
				type: "cli-pw-ext-result",
				sessionId: w.sessionId,
				requestId: "r-1",
				ok: false,
				error: "pw-ext request.verb is not a supported verb",
			},
		]);
		expect(cli.data.invalidFrameCount).toBe(1);
	});

	it("answers with invalid-request when the id is too long", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, pwRequest({ requestId: "x".repeat(129), request: { verb: "jump" } }));
		expect(cliResults(cli)[0]).toMatchObject({ requestId: "invalid-request", ok: false });
	});

	it("answers an invalid cancel with one error frame and one strike", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, { type: "cli-pw-ext-cancel" });
		expect(cliResults(cli)).toEqual([]);
		const errors = sentOfType(cli, "error");
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("chat frame.type must be one of the ratified discriminants, got cli-pw-ext-cancel");
		expect(cli.data.invalidFrameCount).toBe(1);
	});

	it("leaves a staged asset alone when an upload request is invalid", async () => {
		const w = await world();
		const cli = w.cli();
		const assetId = randomUUID();
		await registerAsset(
			{ paths: w.deps.paths, store: w.store },
			{
				sessionId: w.sessionId,
				id: assetId,
				filename: "upload.txt",
				contentType: "text/plain",
				bytes: Buffer.from("hello"),
			},
		);
		await w.post(
			cli,
			pwRequest({
				requestId: "r-1",
				request: {
					verb: "upload",
					target: "#f",
					assetId,
					fileName: "upload.txt",
					fileSize: -1,
					fileType: "text/plain",
					filePath: "upload.txt",
				},
			}),
		);
		expect(cliResults(cli)[0]).toMatchObject({
			ok: false,
			error: "pw-ext request.fileSize must be 0 to 26214400 bytes",
		});
		expect(cli.data.invalidFrameCount).toBe(1);
		expect(w.store.getAsset(w.sessionId, assetId)?.state).toBe("active");
	});
});

describe("relay send modes", () => {
	it("rejects handleSocketMessage when a refusal cannot be sent", async () => {
		const w = await world();
		const cli = w.cli();
		rejectSends(cli);
		await expect(w.post(cli, pwRequest())).rejects.toThrow("socket write failed");
	});

	it("resolves when the result of a forwarded request cannot be sent", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, pwRequest({ requestId: "r-1" }));
		rejectSends(cli);
		await expect(w.post(ext, pwResult(w, "r-1"))).resolves.toBeUndefined();
	});
});

describe("relay generic mechanics", () => {
	async function testWorld(hooks?: RelayHooks<typeof TEST_RELAY>) {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: TEST_RELAY, hooks });
		const request = (requestId: string, extra: Partial<TestCliRequest> = {}) =>
			relay.handleRequest(cli, w.sessionId, {
				type: "cli-test-request",
				requestId,
				...extra,
			});
		const reply = (requestId: string, extra: Frame = {}) =>
			relay.handleResult(ext, {
				sessionId: w.sessionId,
				requestId,
				ok: true,
				data: "x",
				...extra,
			});
		return { w, cli, ext, relay, request, reply };
	}

	it("leaves a pending request armed when toCliResult throws", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({
			deps: w.deps,
			feature: {
				...TEST_RELAY,
				toCliResult: (_frame: { requestId: string; ok: boolean }) => {
					throw new Error("bad data");
				},
			},
		});
		await relay.handleRequest(cli, w.sessionId, {
			type: "cli-test-request",
			requestId: "a",
			timeoutMs: 30,
		});
		expect(() =>
			relay.handleResult(ext, { sessionId: w.sessionId, requestId: "a", ok: true }),
		).toThrow("bad data");
		await until(() => sentOfType(cli, "cli-test-result").length === 1);
		expect(sentOfType(cli, "cli-test-result")[0]).toMatchObject({
			error: "test: timed out after 30ms; status none",
		});
	});

	it("records progress from the owning extension in the timeout text", async () => {
		const t = await testWorld();
		await t.request("a", { timeoutMs: 40 });
		t.relay.handleProgress(t.ext, { sessionId: t.w.sessionId, requestId: "a", status: "loading" });
		await until(() => sentOfType(t.cli, "cli-test-result").length === 1);
		expect(sentOfType(t.cli, "cli-test-result")[0]).toMatchObject({
			error: "test: timed out after 40ms; status loading",
		});
	});

	it("ignores progress from another socket or a page socket", async () => {
		const t = await testWorld();
		await t.request("a", { timeoutMs: 40 });
		const other = t.w.extension(TEST_VERSION);
		const page = t.w.page();
		for (const socket of [other, page])
			t.relay.handleProgress(socket, { sessionId: t.w.sessionId, requestId: "a", status: "forged" });
		await until(() => sentOfType(t.cli, "cli-test-result").length === 1);
		expect(sentOfType(t.cli, "cli-test-result")[0]).toMatchObject({
			error: "test: timed out after 40ms; status none",
		});
	});

	it("sends the outbound request keys in table order", async () => {
		const t = await testWorld();
		await t.request("a", { tag: "t", timeoutMs: 77 });
		expect(t.ext.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "test-browser-request",
				sessionId: t.w.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: "a",
				tag: "t",
				timeoutMs: 77,
			}),
		);
	});

	it("shares one pending map between two relays for the same manager and feature", async () => {
		const t = await testWorld();
		const second = createBrowserRelay({ deps: t.w.deps, feature: TEST_RELAY });
		await t.request("a");
		second.handleCancel(t.cli, t.w.sessionId, { requestId: "a" });
		await until(() => sentOfType(t.ext, "test-browser-cancel").length === 1);
		await quiet();
		expect(t.cli.send.mock.calls).toHaveLength(0);
	});

	it("keeps one closed listener however many requests arrive", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, pwRequest());
		const afterFirst = w.registry.listenerCount("closed");
		for (let i = 0; i < 49; i++) await w.post(cli, pwRequest());
		expect(w.registry.listenerCount("closed")).toBe(afterFirst);
	});

	it("settles through salvage and does not authorize the raw token", async () => {
		const t = await testWorld({
			salvage: ({ raw }) => ({
				sessionId: String(raw.sessionId),
				requestId: String(raw.requestId),
				ok: true,
				data: "salvaged",
			}),
		});
		await t.request("a");
		const settled = t.relay.settleRejected(t.ext, {
			type: "test-browser-result",
			sessionId: t.w.sessionId,
			requestId: "a",
		});
		expect(settled).toBe(true);
		await until(() => sentOfType(t.cli, "cli-test-result").length === 1);
		expect(sentOfType(t.cli, "cli-test-result")[0]).toMatchObject({ ok: true, data: "salvaged" });
	});

	it("rejects with the salvage error text", async () => {
		const t = await testWorld({
			salvage: () => {
				throw new TypeError("cannot repair");
			},
		});
		await t.request("a");
		expect(
			t.relay.settleRejected(t.ext, {
				type: "test-browser-result",
				sessionId: t.w.sessionId,
				requestId: "a",
			}),
		).toBe(true);
		await until(() => sentOfType(t.cli, "cli-test-result").length === 1);
		expect(sentOfType(t.cli, "cli-test-result")[0]).toMatchObject({
			ok: false,
			error: "test: rejected cannot repair",
		});
	});

	it("settles nothing for a rejected result from a socket that does not own the request", async () => {
		const t = await testWorld({
			salvage: () => {
				throw new TypeError("cannot repair");
			},
		});
		await t.request("a");
		const other = t.w.extension(TEST_VERSION);
		expect(
			t.relay.settleRejected(other, {
				type: "test-browser-result",
				sessionId: t.w.sessionId,
				requestId: "a",
			}),
		).toBe(false);
		await quiet();
		expect(t.cli.send.mock.calls).toHaveLength(0);
	});

	it("fails every pending request of one extension socket", async () => {
		const t = await testWorld();
		await t.request("a");
		t.relay.failAll(t.ext, "boom");
		await until(() => sentOfType(t.cli, "cli-test-result").length === 1);
		expect(sentOfType(t.cli, "cli-test-result")[0]).toMatchObject({ ok: false, error: "boom" });
	});
});

describe("relay settled and prepare hooks", () => {
	type Log = (string | RelayOutcome["kind"])[];

	async function hooked() {
		const log: Log = [];
		const outcomes: RelayOutcome[] = [];
		const w = await world();
		const cli = w.cli({
			send: mock((_payload: string) => log.push("cli-send")),
		});
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({
			deps: w.deps,
			feature: TEST_RELAY,
			hooks: {
				settled: ({ outcome }) => {
					outcomes.push(outcome);
					log.push(`settled:${outcome.kind}`);
				},
			},
		});
		const request = (requestId: string, extra: Partial<TestCliRequest> = {}) =>
			relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId, ...extra });
		return { w, cli, ext, relay, request, log, outcomes };
	}

	it("fires once with kind error for a refusal, before the CLI send", async () => {
		const h = await hooked();
		abortPendingWork(h.ext);
		h.w.connections.remove(h.ext);
		await h.request("a");
		expect(h.log).toEqual(["settled:error", "cli-send"]);
	});

	it("fires once with kind ok for a delivered result, before the CLI send", async () => {
		const h = await hooked();
		await h.request("a");
		h.relay.handleResult(h.ext, { sessionId: h.w.sessionId, requestId: "a", ok: true, data: "x" });
		await until(() => h.log.includes("cli-send"));
		expect(h.log).toEqual(["settled:ok", "cli-send"]);
		expect(h.outcomes[0]).toEqual({ kind: "ok", result: { ok: true, data: "x" } });
	});

	it("fires once with kind timeout before the CLI send", async () => {
		const h = await hooked();
		await h.request("a", { timeoutMs: 20 });
		await until(() => h.log.includes("cli-send"));
		expect(h.log).toEqual(["settled:timeout", "cli-send"]);
	});

	it("fires once with kind canceled and sends no CLI result", async () => {
		const h = await hooked();
		await h.request("a");
		h.relay.handleCancel(h.w.cli(), h.w.sessionId, { requestId: "a" });
		expect(h.log).toEqual([]);
		h.relay.handleCancel(h.cli, h.w.sessionId, { requestId: "a" });
		await quiet();
		expect(h.log).toEqual(["settled:canceled"]);
	});

	it("fires once with kind closed when the session closes", async () => {
		const h = await hooked();
		await h.request("a");
		h.w.deps.registry.emit("closed", { sessionId: h.w.sessionId, reason: "closed" });
		await until(() => h.log.includes("cli-send"));
		expect(h.log).toEqual(["settled:closed", "cli-send"]);
	});

	it("fires once with kind disconnected for the requester and sends nothing", async () => {
		const h = await hooked();
		await h.request("a");
		abortPendingWork(h.cli);
		await quiet();
		expect(h.log).toEqual(["settled:disconnected"]);
		expect(h.outcomes[0]).toEqual({ kind: "disconnected", peer: "requester" });
	});

	it("fires once with kind disconnected for the extension, before the CLI send", async () => {
		const h = await hooked();
		await h.request("a");
		abortPendingWork(h.ext);
		await until(() => h.log.includes("cli-send"));
		expect(h.log).toEqual(["settled:disconnected", "cli-send"]);
		expect(h.outcomes[0]).toEqual({ kind: "disconnected", peer: "extension" });
	});

	it("does not fire for a silent duplicate drop", async () => {
		const h = await hooked();
		await h.request("a");
		await h.request("a");
		await quiet();
		expect(h.log).toEqual([]);
	});

	it("refuses with the prepare error and fires settled once with kind error", async () => {
		const log: string[] = [];
		const w = await world();
		const cli = w.cli();
		w.extension(TEST_VERSION);
		const relay = createBrowserRelay({
			deps: w.deps,
			feature: TEST_RELAY,
			hooks: {
				prepare: () => ({ error: "nope" }),
				settled: ({ outcome }) => log.push(outcome.kind),
			},
		});
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "a" });
		expect(sentOfType(cli, "cli-test-result")).toMatchObject([{ ok: false, error: "nope" }]);
		expect(log).toEqual(["error"]);
	});

	it("uses the CLI request prepare returns", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({
			deps: w.deps,
			feature: TEST_RELAY,
			hooks: { prepare: ({ cli: request }) => ({ ...request, tag: "prepared" }) },
		});
		await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId: "a" });
		expect(sentOfType(ext, "test-browser-request")[0]).toMatchObject({ tag: "prepared" });
	});
});

describe("relay hook and string safety", () => {
	type TestStrings = (typeof TEST_RELAY)["strings"];
	type TestFeature = Omit<typeof TEST_RELAY, "strings"> & {
		strings: Omit<TestStrings, "canceled"> & { canceled?: string };
	};

	async function guarded(feature: TestFeature = TEST_RELAY, hooks?: RelayHooks<typeof TEST_RELAY>) {
		const w = await world();
		const errors: string[] = [];
		const deps: FrameHandlerDeps = {
			...w.deps,
			logger: { ...logger, error: (message) => errors.push(message) },
		};
		const relay = createBrowserRelay({ deps, feature, hooks });
		const ext = w.extension(TEST_VERSION);
		const request = (cli: FakeSocket, requestId: string, extra: Partial<TestCliRequest> = {}) =>
			relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId, ...extra });
		return { w, relay, ext, errors, request };
	}

	const throwingHook: RelayHooks<typeof TEST_RELAY> = {
		settled() {
			throw new TypeError("secret frame data");
		},
	};

	it("still delivers the CLI result when a settled hook throws", async () => {
		const h = await guarded(TEST_RELAY, throwingHook);
		const cli = h.w.cli();
		await h.request(cli, "a");
		h.relay.handleResult(h.ext, { sessionId: h.w.sessionId, requestId: "a", ok: true, data: "x" });
		await until(() => sentOfType(cli, "cli-test-result").length === 1);
		expect(sentOfType(cli, "cli-test-result")[0]).toMatchObject({ ok: true, data: "x" });
		expect(h.errors).toEqual(["relay test settled hook threw TypeError"]);
	});

	it("settles both pending entries on a session close when the hook throws", async () => {
		const h = await guarded(TEST_RELAY, throwingHook);
		const first = h.w.cli();
		const second = h.w.cli();
		await h.request(first, "a");
		await h.request(second, "b");
		h.w.deps.registry.emit("closed", { sessionId: h.w.sessionId, reason: "closed" });
		await until(
			() =>
				sentOfType(first, "cli-test-result").length === 1 &&
				sentOfType(second, "cli-test-result").length === 1,
		);
		expect(sentOfType(first, "cli-test-result")[0]).toMatchObject({ ok: false, error: "test: session closed" });
		expect(sentOfType(second, "cli-test-result")[0]).toMatchObject({ ok: false, error: "test: session closed" });
		expect(h.errors).toHaveLength(2);
	});

	it("answers a timeout with the fallback text when the timeout string throws", async () => {
		const h = await guarded({
			...TEST_RELAY,
			strings: {
				...TEST_RELAY.strings,
				timeout: () => {
					throw new RangeError("bad template");
				},
			},
		});
		const cli = h.w.cli();
		await h.request(cli, "a", { timeoutMs: 20 });
		await until(() => sentOfType(cli, "cli-test-result").length === 1);
		expect(sentOfType(cli, "cli-test-result")[0]).toMatchObject({
			ok: false,
			error: "The relay request timed out.",
		});
		expect(h.errors).toEqual(["relay test timeout hook threw RangeError"]);
	});

	it("ignores a cancel for a feature without a canceled string and keeps the request pending", async () => {
		const { canceled: _canceled, ...strings } = TEST_RELAY.strings;
		const h = await guarded({ ...TEST_RELAY, strings });
		const cli = h.w.cli();
		await h.request(cli, "a");
		h.relay.handleCancel(cli, h.w.sessionId, { requestId: "a" });
		await quiet();
		expect(sentOfType(h.ext, "test-browser-cancel")).toEqual([]);
		expect(sentOfType(cli, "cli-test-result")).toEqual([]);
		h.relay.handleResult(h.ext, { sessionId: h.w.sessionId, requestId: "a", ok: true, data: "x" });
		await until(() => sentOfType(cli, "cli-test-result").length === 1);
	});
});

describe("relay oversized and unreadable handling", () => {
	async function pendingTwo() {
		const w = await world();
		const first = w.cli();
		const second = w.cli();
		const ext = w.extension(TEST_VERSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: TEST_RELAY });
		for (const [cli, requestId] of [[first, "a"], [second, "b"]] as const)
			await relay.handleRequest(cli, w.sessionId, { type: "cli-test-request", requestId });
		return { w, first, second, ext, relay };
	}

	it("stops after an oversized result when the feature says return", async () => {
		const h = await pendingTwo();
		const frame = { type: "test-browser-result", sessionId: h.w.sessionId, requestId: "a", token: h.w.token };
		expect(settleOversizedRelays(h.ext, frame, [h.relay])).toBe(true);
		await until(() => sentOfType(h.first, "cli-test-result").length === 1);
		expect(sentOfType(h.first, "cli-test-result")[0]).toMatchObject({
			ok: false,
			error: "test: rejected test: too big",
		});
		expect(sentOfType(h.second, "cli-test-result")).toEqual([]);
	});

	it("reports no stop when no pending request matches the oversized result", async () => {
		const h = await pendingTwo();
		const frame = { type: "test-browser-result", sessionId: h.w.sessionId, requestId: "none", token: h.w.token };
		expect(settleOversizedRelays(h.ext, frame, [h.relay])).toBe(false);
	});

	it("fails every pending request of the extension for an unreadable frame", async () => {
		const h = await pendingTwo();
		failUnreadableRelays(h.ext, undefined, [h.relay]);
		await until(
			() =>
				sentOfType(h.first, "cli-test-result").length === 1 &&
				sentOfType(h.second, "cli-test-result").length === 1,
		);
		for (const cli of [h.first, h.second])
			expect(sentOfType(cli, "cli-test-result")[0]).toMatchObject({ ok: false, error: "test: unreadable" });
	});

	it("fails nothing for an oversized frame of another type", async () => {
		const h = await pendingTwo();
		failUnreadableRelays(h.ext, { type: "other" }, [h.relay]);
		await quiet();
		expect(sentOfType(h.first, "cli-test-result")).toEqual([]);
	});
});

describe("relay route table", () => {
	it("throws at build time when two features share a frame type", async () => {
		const w = await world();
		expect(() =>
			buildRelayRoutes(w.deps, [{ feature: TEST_RELAY }, { feature: TEST_RELAY }]),
		).toThrow("relay frame type cli-test-request is registered twice");
	});
});

describe("pw-ext staged asset cleanup", () => {
	async function staged(w: World): Promise<{ assetId: string; request: Frame }> {
		const assetId = randomUUID();
		await registerAsset(
			{ paths: w.deps.paths, store: w.store },
			{
				sessionId: w.sessionId,
				id: assetId,
				filename: "upload.txt",
				contentType: "text/plain",
				bytes: Buffer.from("hello"),
			},
		);
		return {
			assetId,
			request: pwRequest({
				requestId: "r-1",
				request: {
					verb: "upload",
					target: "#f",
					assetId,
					fileName: "upload.txt",
					fileSize: 5,
					fileType: "text/plain",
					filePath: "upload.txt",
				},
			}),
		};
	}

	it("deletes the asset when the request is refused for no peer", async () => {
		const w = await world();
		const cli = w.cli();
		const { assetId, request } = await staged(w);
		await w.post(cli, request);
		expect(w.store.getAsset(w.sessionId, assetId)?.state).toBe("deleted");
	});

	it("deletes the asset on timeout", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		const { assetId, request } = await staged(w);
		await w.post(cli, { ...request, timeoutMs: 20 });
		await until(() => cliResults(cli).length === 1);
		expect(w.store.getAsset(w.sessionId, assetId)?.state).toBe("deleted");
	});

	it("deletes the asset on cancel", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		const { assetId, request } = await staged(w);
		await w.post(cli, request);
		expect(w.store.getAsset(w.sessionId, assetId)?.state).toBe("active");
		await w.post(cli, { type: "cli-pw-ext-cancel", requestId: "r-1" });
		expect(w.store.getAsset(w.sessionId, assetId)?.state).toBe("deleted");
	});

	it("deletes the asset on an extension error result", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		const { assetId, request } = await staged(w);
		await w.post(cli, request);
		await w.post(ext, pwResult(w, "r-1", { ok: false, data: undefined, error: "tab closed" }));
		expect(w.store.getAsset(w.sessionId, assetId)?.state).toBe("deleted");
	});

	it("deletes the asset on an ok result", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		const { assetId, request } = await staged(w);
		await w.post(cli, request);
		await w.post(ext, pwResult(w, "r-1"));
		expect(w.store.getAsset(w.sessionId, assetId)?.state).toBe("deleted");
	});

	it("swallows a delete failure in the settled hook", async () => {
		const w = await world();
		const hooks = pwExtRelayHooks(w.deps);
		const cli = {
			type: "cli-pw-ext-request" as const,
			requestId: "r-1",
			request: { verb: "upload" as const, assetId: "../escape" },
		};
		expect(() =>
			hooks.settled?.({
				outcome: { kind: "timeout" },
				cli,
				sessionId: w.sessionId,
				requestId: "r-1",
				requester: w.cli(),
			}),
		).not.toThrow();
	});
});
