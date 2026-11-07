import {
	afterEach,
	describe,
	expect,
	it,
	type Mock,
	mock,
	spyOn,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	INBOX_RELAY,
	PROTO_RELAY,
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
import { protoRelayHooks } from "../../src/server/proto";
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
import { WS_PAYLOAD_HEADROOM_BYTES } from "../../src/server/http";
import { ChatStore } from "../../src/store";
import type { CredentialStore } from "../../src/store/credentials-store";
import { inboxProfile } from "../../../common/__tests__/utils/inbox-fixtures";
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

	it("settles a request as an error with fixed text when the prepare hook throws", async () => {
		const kinds: string[] = [];
		let calls = 0;
		const h = await guarded(TEST_RELAY, {
			prepare: ({ cli }) => {
				calls++;
				if (calls === 1) throw new TypeError("secret frame data");
				return cli;
			},
			settled: ({ outcome }) => kinds.push(outcome.kind),
		});
		const cli = h.w.cli();
		await h.request(cli, "a");
		expect(sentOfType(cli, "cli-test-result")).toMatchObject([
			{ ok: false, error: "The relay could not prepare the request." },
		]);
		expect(kinds).toEqual(["error"]);
		expect(h.errors).toEqual(["relay test prepare hook threw TypeError"]);
		await h.request(cli, "a");
		expect(sentOfType(h.ext, "test-browser-request")).toHaveLength(1);
		expect(kinds).toEqual(["error"]);
	});

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

const INBOX_EXTENSION = "1.11.0";
function noPeerHint(sessionId: string, required: readonly string[]): RegExp {
	const pair = `dg-agent pair <code> -s ${sessionId}`.replace(
		/[.*+?^${}()|[\]\\]/g,
		"\\$&",
	);
	const lookaheads = [pair, ...required].map((part) => `(?=.*${part})`);
	return new RegExp(`^(?!.*/start#_chat=)${lookaheads.join("")}.*$`, "s");
}

const INBOX_FOLDERS = { folders: [{ id: "folder-a", name: "Reviewed" }] };
const INBOX_REFUSAL = {
	active: "Inbox requires an active dg session.",
	tooMany:
		"Inbox has too many pending requests from this client; wait for existing work to finish.",
	used: "Inbox requestId was already used; create a new requestId.",
	capacity:
		"Inbox request capacity reached; finish pending work or start a new session.",
	multiple:
		"Multiple extension peers make the inbox request ambiguous; keep one extension connected to this session.",
	oldVersion:
		"Inbox requires dg extension 1.11.0 or newer; update the extension, reload it, and reconnect this session.",
	noPeer: (sessionId: string) =>
		expect.stringMatching(
			noPeerHint(sessionId, ["1\\.11\\.0", "[Rr]eload"]),
		),
	storage:
		"Inbox configuration storage failed; check daemon health and encryption key access.",
};
const INBOX_END = {
	timeout:
		"Inbox extension request timed out; check the authenticated Proton tab and retry with a new requestId.",
	closed: "Inbox session closed before the extension replied.",
	extension: "Inbox extension disconnected before replying.",
	sendFailed:
		"Inbox extension request could not be sent; reconnect the extension.",
};

function inboxRequest(overrides: Frame = {}): Frame {
	return {
		type: "cli-inbox-request",
		requestId: randomUUID(),
		operation: "browser",
		request: { operation: "list-folders" },
		timeoutMs: 60_000,
		...overrides,
	};
}

function inboxReply(w: World, requestId: string, overrides: Frame = {}): Frame {
	return {
		type: "inbox-browser-result",
		sessionId: w.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		token: w.token,
		requestId,
		ok: true,
		data: INBOX_FOLDERS,
		...overrides,
	};
}

function inboxResults(ws: FakeSocket): Frame[] {
	return sentOfType(ws, "cli-inbox-result");
}

describe("inbox relay bytes", () => {
	it("sends the pinned browser request and CLI result bytes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		const request = { operation: "list-folders" };
		await w.post(cli, {
			type: "cli-inbox-request",
			requestId: "r-1",
			operation: "browser",
			request,
		});
		expect(ext.send.mock.calls).toHaveLength(1);
		expect(ext.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "inbox-browser-request",
				sessionId: w.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: "r-1",
				request,
			}),
		);
		await w.post(ext, inboxReply(w, "r-1"));
		await until(() => cli.send.mock.calls.length === 1);
		expect(cli.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "cli-inbox-result",
				sessionId: w.sessionId,
				requestId: "r-1",
				ok: true,
				value: INBOX_FOLDERS,
			}),
		);
	});

	it("sends a failed extension result as an error result", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-2" }));
		await w.post(
			ext,
			inboxReply(w, "r-2", { ok: false, data: undefined, error: "expired" }),
		);
		await until(() => cli.send.mock.calls.length === 1);
		expect(cli.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "cli-inbox-result",
				sessionId: w.sessionId,
				requestId: "r-2",
				ok: false,
				error: "expired",
			}),
		);
	});
});

describe("inbox relay check order", () => {
	async function settled(w: World, cli: FakeSocket, ext: FakeSocket, id: string) {
		await w.post(cli, inboxRequest({ requestId: id }));
		await w.post(ext, inboxReply(w, id));
		await until(() => inboxResults(cli).length === 1);
	}

	it("answers the active refusal before the duplicate drop", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "a" }));
		const record = w.registry.get(w.sessionId);
		if (!record) throw new Error("session missing");
		record.state = "closed";
		await w.post(cli, inboxRequest({ requestId: "a" }));
		expect(inboxResults(cli)).toMatchObject([
			{ ok: false, error: INBOX_REFUSAL.active },
		]);
	});

	it("drops a pending id resent by the same requester before the requester cap", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension(INBOX_EXTENSION);
		for (let i = 0; i < 8; i++)
			await w.post(cli, inboxRequest({ requestId: `p${i}` }));
		await w.post(cli, inboxRequest({ requestId: "p0" }));
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
	});

	it("answers the requester cap before the replay refusal", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await settled(w, cli, ext, "used");
		for (let i = 0; i < 8; i++)
			await w.post(cli, inboxRequest({ requestId: `p${i}` }));
		await w.post(cli, inboxRequest({ requestId: "used" }));
		expect(inboxResults(cli)).toHaveLength(2);
		expect(inboxResults(cli)[1]).toMatchObject({
			ok: false,
			error: INBOX_REFUSAL.tooMany,
		});
	});

	it("answers the replay refusal before the pending cap and the pending cap before the peers refusal", async () => {
		const w = await world();
		const settler = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await settled(w, settler, ext, "used");
		for (let client = 0; client < 16; client++) {
			const cli = w.cli();
			for (let i = 0; i < 8; i++)
				await w.post(cli, inboxRequest({ requestId: `c${client}-${i}` }));
		}
		await w.post(settler, inboxRequest({ requestId: "used" }));
		expect(inboxResults(settler)[1]).toMatchObject({ error: INBOX_REFUSAL.used });
		await w.post(settler, inboxRequest({ requestId: "fresh" }));
		expect(inboxResults(settler)[2]).toMatchObject({
			ok: false,
			error: INBOX_REFUSAL.capacity,
		});
		w.extension(INBOX_EXTENSION);
		await w.post(settler, inboxRequest({ requestId: "fresh-2" }));
		expect(inboxResults(settler)[3]).toMatchObject({
			error: INBOX_REFUSAL.capacity,
		});
	});

	it("answers the replay refusal before the peers refusal", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await settled(w, cli, ext, "used");
		abortPendingWork(ext);
		w.connections.remove(ext);
		await w.post(cli, inboxRequest({ requestId: "used" }));
		expect(inboxResults(cli)[1]).toMatchObject({ error: INBOX_REFUSAL.used });
	});

	it("answers the peers refusal before the version refusal", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension("1.10.0");
		w.extension("1.10.0");
		await w.post(cli, inboxRequest());
		expect(inboxResults(cli)).toMatchObject([
			{ ok: false, error: INBOX_REFUSAL.multiple },
		]);
	});

	it("answers the no-peer refusal with the pairing hint", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, inboxRequest());
		expect(inboxResults(cli)).toMatchObject([
			{ ok: false, error: INBOX_REFUSAL.noPeer(w.sessionId) },
		]);
	});
});

describe("inbox relay burn point and duplicates", () => {
	it("refuses a resend of an id refused for no peer, even after an extension connects", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		expect(inboxResults(cli)[0]).toMatchObject({
			error: INBOX_REFUSAL.noPeer(w.sessionId),
		});
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		expect(inboxResults(cli)[1]).toMatchObject({ error: INBOX_REFUSAL.used });
		expect(sentOfType(ext, "inbox-browser-request")).toEqual([]);
	});

	it("burns the id before the version refusal", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension("1.10.99");
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		expect(inboxResults(cli)[0]).toMatchObject({
			error: INBOX_REFUSAL.oldVersion,
		});
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		expect(inboxResults(cli)[1]).toMatchObject({ error: INBOX_REFUSAL.used });
	});

	it("accepts an extension version with build metadata", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension("1.11.0+build.1");
		await w.post(cli, inboxRequest());
		expect(sentOfType(ext, "inbox-browser-request")).toHaveLength(1);
		expect(inboxResults(cli)).toEqual([]);
	});

	it("drops a pending id resent by the same requester without an answer", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "a" }));
		await w.post(cli, inboxRequest({ requestId: "a" }));
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
		expect(sentOfType(ext, "inbox-browser-request")).toHaveLength(1);
	});

	it("refuses a pending id resent by another CLI socket", async () => {
		const w = await world();
		const first = w.cli();
		const second = w.cli();
		w.extension(INBOX_EXTENSION);
		await w.post(first, inboxRequest({ requestId: "a" }));
		await w.post(second, inboxRequest({ requestId: "a" }));
		expect(inboxResults(second)).toMatchObject([
			{ ok: false, error: INBOX_REFUSAL.used },
		]);
		expect(inboxResults(first)).toEqual([]);
	});

	it("refuses the ninth pending request from one requester across two sessions", async () => {
		const w = await world();
		const cli = w.cli();
		const other = w.registry.create({
			cwd: w.dgHome,
			agentIdentity: "other",
			role: "agent",
		});
		w.connections.add(
			fakeSocket("ws", {
				extensionVersion: INBOX_EXTENSION,
				capabilities: [[other.sessionId, other.token]],
			}),
		);
		w.extension(INBOX_EXTENSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: INBOX_RELAY });
		const request = (sessionId: string, requestId: string) =>
			relay.handleRequest(cli, sessionId, {
				type: "cli-inbox-request",
				requestId,
				operation: "browser",
				request: { operation: "list-folders" },
			});
		for (let i = 0; i < 4; i++) {
			await request(w.sessionId, `a${i}`);
			await request(other.sessionId, `b${i}`);
		}
		await request(w.sessionId, "ninth");
		expect(inboxResults(cli)).toMatchObject([
			{ ok: false, error: INBOX_REFUSAL.tooMany },
		]);
	});
});

describe("inbox relay store branch", () => {
	it("answers an inactive session without touching relay state", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "warm", operation: "profile-list", request: undefined }));
		const listeners = w.registry.listenerCount("closed");
		const record = w.registry.get(w.sessionId);
		if (!record) throw new Error("session missing");
		record.state = "closed";
		await w.post(cli, inboxRequest({ requestId: "same", operation: "profile-list", request: undefined }));
		expect(inboxResults(cli)[1]).toMatchObject({
			requestId: "same",
			ok: false,
			error: INBOX_REFUSAL.active,
		});
		record.state = "active";
		await w.post(cli, inboxRequest({ requestId: "same" }));
		expect(sentOfType(ext, "inbox-browser-request")).toMatchObject([
			{ requestId: "same" },
		]);
		expect(w.registry.listenerCount("closed")).toBe(listeners);
	});

	it("round-trips a profile through the store with no extension send", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		const profile = inboxProfile();
		await w.post(cli, inboxRequest({ requestId: "set", operation: "profile-set", request: undefined, name: "personal", profile }));
		await w.post(cli, inboxRequest({ requestId: "get", operation: "profile-get", request: undefined, name: "personal" }));
		expect(cli.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "cli-inbox-result",
				sessionId: w.sessionId,
				requestId: "set",
				ok: true,
				value: null,
			}),
		);
		expect(inboxResults(cli)[1]).toMatchObject({ requestId: "get", ok: true, value: profile });
		expect(w.store.getInboxProfile("personal")).toEqual(profile);
		expect(ext.send.mock.calls).toHaveLength(0);
	});

	it("answers a store failure with the storage string", async () => {
		const w = await world();
		const cli = w.cli();
		const failing = spyOn(w.store, "getInboxProfile").mockImplementation(() => {
			throw new Error("disk");
		});
		cleanups.push(() => failing.mockRestore());
		await w.post(cli, inboxRequest({ operation: "profile-get", request: undefined, name: "personal" }));
		expect(inboxResults(cli)).toMatchObject([
			{ ok: false, error: INBOX_REFUSAL.storage },
		]);
	});
});

describe("inbox relay ends", () => {
	it("answers a timeout and sends the extension no cancel frame", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1", timeoutMs: 20 }));
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({
			ok: false,
			error: INBOX_END.timeout,
		});
		expect(sentFrames(ext).map((frame) => frame.type)).toEqual([
			"inbox-browser-request",
		]);
	});

	it("sends nothing to anyone when the requester closes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		abortPendingWork(cli);
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
		expect(sentFrames(ext).map((frame) => frame.type)).toEqual([
			"inbox-browser-request",
		]);
	});

	it("answers when the extension closes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		abortPendingWork(ext);
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({
			ok: false,
			error: INBOX_END.extension,
		});
	});

	it("answers when the session closes", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		w.deps.registry.emit("closed", { sessionId: w.sessionId, reason: "closed" });
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({
			ok: false,
			error: INBOX_END.closed,
		});
	});

	it("answers when the extension send fails", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		rejectSends(ext);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({
			ok: false,
			error: INBOX_END.sendFailed,
		});
	});

	it("ignores a second result for a settled request", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		await w.post(ext, inboxReply(w, "r-1"));
		await w.post(ext, inboxReply(w, "r-1"));
		await quiet();
		expect(inboxResults(cli)).toHaveLength(1);
	});

	it("ignores a result from a second extension socket or a page socket", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		await w.post(w.extension(INBOX_EXTENSION), inboxReply(w, "r-1"));
		await w.post(w.page(), inboxReply(w, "r-1"));
		await quiet();
		expect(inboxResults(cli)).toEqual([]);
	});

	it("ignores the wrong request, wrong session, and wrong token", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		await w.post(ext, inboxReply(w, "wrong-request-id"));
		await w.post(ext, inboxReply(w, "r-1", { sessionId: "other-session" }));
		await w.post(ext, inboxReply(w, "r-1", { token: "wrong-token" }));
		await quiet();
		expect(inboxResults(cli)).toEqual([]);
		await w.post(ext, inboxReply(w, "r-1"));
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({ ok: true });
	});

	it("abandons a disconnected requester without routing its late result to another CLI", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		abortPendingWork(cli);
		const nextCli = w.cli();
		await w.post(ext, inboxReply(w, "r-1"));
		await quiet();
		expect(inboxResults(cli)).toEqual([]);
		expect(inboxResults(nextCli)).toEqual([]);
		await w.post(nextCli, inboxRequest({ requestId: "r-2" }));
		await w.post(ext, inboxReply(w, "r-2"));
		await until(() => inboxResults(nextCli).length === 1);
		expect(inboxResults(nextCli)[0]).toMatchObject({
			requestId: "r-2",
			ok: true,
		});
		expect(inboxResults(cli)).toEqual([]);
	});

	it("ignores a late reply after a timeout and accepts the next request", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1", timeoutMs: 20 }));
		await until(() => inboxResults(cli).length === 1);
		await w.post(ext, inboxReply(w, "r-1"));
		await quiet();
		expect(inboxResults(cli)).toHaveLength(1);
		await w.post(cli, inboxRequest({ requestId: "r-2" }));
		await w.post(ext, inboxReply(w, "r-2"));
		await until(() => inboxResults(cli).length === 2);
		expect(inboxResults(cli)[1]).toMatchObject({ requestId: "r-2", ok: true });
	});

	it("keeps the relay usable after a provider failure", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		await w.post(
			ext,
			inboxReply(w, "r-1", { ok: false, data: undefined, error: "expired" }),
		);
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({ ok: false, error: "expired" });
		await w.post(cli, inboxRequest({ requestId: "r-2" }));
		await w.post(ext, inboxReply(w, "r-2"));
		await until(() => inboxResults(cli).length === 2);
		expect(inboxResults(cli)[1]).toMatchObject({ requestId: "r-2", ok: true });
	});

	it("refreshes the session activity before it handles a result", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1" }));
		const record = w.registry.get(w.sessionId);
		if (!record) throw new Error("session missing");
		record.lastActivityAt = 0;
		await w.post(ext, inboxReply(w, "r-1"));
		expect(record.lastActivityAt).toBeGreaterThan(0);
	});
});

describe("inbox relay unreadable results", () => {
	async function pending() {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		await w.post(cli, inboxRequest({ requestId: "r-1", timeoutMs: 100 }));
		return { w, cli, ext };
	}

	it("keeps waiting for the timeout after an oversized result", async () => {
		const { w, cli, ext } = await pending();
		const raw = JSON.stringify(
			inboxReply(w, "r-1", {
				data: { folders: [{ id: "x", name: "x".repeat(CHAT_MAX_PAYLOAD_BYTES) }] },
			}),
		);
		await w.postRaw(ext, raw);
		expect(inboxResults(cli)).toEqual([]);
		expect(sentOfType(ext, "error")).toMatchObject([
			{
				message: `payload of ${Buffer.byteLength(raw)} bytes exceeds CHAT_MAX_PAYLOAD_BYTES (${CHAT_MAX_PAYLOAD_BYTES})`,
			},
		]);
		expect(ext.data.invalidFrameCount).toBe(1);
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({ error: INBOX_END.timeout });
	});

	it("keeps waiting for the timeout after an invalid result", async () => {
		const { w, cli, ext } = await pending();
		await w.post(
			ext,
			inboxReply(w, "r-1", { data: { messages: [{ id: "m", body: "raw" }] } }),
		);
		expect(inboxResults(cli)).toEqual([]);
		expect(sentOfType(ext, "error")).toHaveLength(1);
		expect(ext.data.invalidFrameCount).toBe(1);
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({ error: INBOX_END.timeout });
	});

	it("propagates a validator throw and keeps the request armed", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension(INBOX_EXTENSION);
		const relay = createBrowserRelay({ deps: w.deps, feature: INBOX_RELAY });
		await relay.handleRequest(cli, w.sessionId, {
			type: "cli-inbox-request",
			requestId: "a",
			operation: "browser",
			request: { operation: "list-folders" },
			timeoutMs: 30,
		});
		const data = JSON.parse('{"messages":[{"id":"m","body":"raw"}]}');
		expect(() =>
			relay.handleResult(ext, {
				sessionId: w.sessionId,
				requestId: "a",
				ok: true,
				data,
			}),
		).toThrow();
		await until(() => inboxResults(cli).length === 1);
		expect(inboxResults(cli)[0]).toMatchObject({ error: INBOX_END.timeout });
	});
});

describe("inbox relay invalid CLI frames", () => {
	it("answers an invalid request with the validator message and one strike, send first", async () => {
		const strikes: number[] = [];
		const w = await world();
		const cli = w.cli({
			send: mock((_payload: string) => strikes.push(cli.data.invalidFrameCount)),
		});
		await w.post(cli, inboxRequest({ requestId: "r-1", operation: "nope" }));
		expect(inboxResults(cli)).toMatchObject([
			{
				sessionId: w.sessionId,
				requestId: "r-1",
				ok: false,
				error:
					"inbox CLI request.operation must be one of profile-get, profile-set, profile-list, cache-get, cache-set, browser",
			},
		]);
		expect(strikes).toEqual([0]);
		expect(cli.data.invalidFrameCount).toBe(1);
	});

	it("answers with invalid-request when the id is too long", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, inboxRequest({ requestId: "x".repeat(129), operation: "nope" }));
		expect(inboxResults(cli)[0]).toMatchObject({ requestId: "invalid-request", ok: false });
	});
});

const PROTO_SLUG = "account-summary-1a2b3c4d";
const PROTO_URL = "https://example.test/account#_proto=fixture";
const PROTO_STYLE_GUIDE = {
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
const PROTO_DATA = { kind: "style-guide", styleGuide: PROTO_STYLE_GUIDE };
const PROTO_VERDICT = {
	slug: PROTO_SLUG,
	action: "approve",
	selectedKey: "compact",
	ts: 1,
};
const PROTO_NOT_READY = {
	code: "login-page",
	message: "the page requires sign-in",
	landedUrl: "https://example.test/login",
} as const;
const PROTO_REFUSAL = {
	active: "Prototype --ext requires an active dg session.",
	used: "Prototype requestId was already used on this session; send a new one.",
	tooMany:
		"Prototype has too many pending requests from this client; wait for existing work to finish.",
	capacity:
		"Prototype request capacity reached; finish pending work or start a new session.",
	multiple:
		"Multiple extension peers make the prototype request ambiguous; keep one extension connected to this session.",
	noPeer: (sessionId: string) =>
		expect.stringMatching(noPeerHint(sessionId, [])),
};
const PROTO_END = {
	closed: "Prototype session closed before the extension replied.",
	extension: "Prototype extension disconnected before replying.",
	sendFailed:
		"Prototype extension request could not be sent; reconnect the extension.",
	unreadable:
		"Prototype result exceeded the relay size limit and could not be delivered.",
	rejected: (detail: string) =>
		`Prototype result could not be delivered: ${detail}`,
};

function protoRequest(overrides: Frame = {}): Frame {
	return {
		type: "cli-proto-request",
		requestId: randomUUID(),
		phase: "scrape",
		slug: PROTO_SLUG,
		markedUrl: PROTO_URL,
		timeoutMs: 60_000,
		...overrides,
	};
}

function protoReply(w: World, requestId: string, overrides: Frame = {}): Frame {
	return {
		type: "proto-browser-result",
		sessionId: w.sessionId,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		token: w.token,
		requestId,
		ok: true,
		data: PROTO_DATA,
		...overrides,
	};
}

function oversizedPreviewReply(
	w: World,
	requestId: string,
	overrides: Frame = {},
): string {
	return JSON.stringify(
		protoReply(w, requestId, {
			data: {
				kind: "verdict",
				verdict: PROTO_VERDICT,
				previewDataUrl: `data:image/png;base64,${"A".repeat(CHAT_MAX_PAYLOAD_BYTES)}`,
			},
			...overrides,
		}),
	);
}

function protoResults(ws: FakeSocket): Frame[] {
	return sentOfType(ws, "cli-proto-result");
}

function oversizeMessage(raw: string): string {
	return `payload of ${Buffer.byteLength(raw)} bytes exceeds CHAT_MAX_PAYLOAD_BYTES (${CHAT_MAX_PAYLOAD_BYTES})`;
}

async function protoSettled(
	w: World,
	cli: FakeSocket,
	ext: FakeSocket,
	id: string,
) {
	await w.post(cli, protoRequest({ requestId: id }));
	await w.post(ext, protoReply(w, id));
	await until(() => protoResults(cli).length === 1);
}

async function protoFillPending(w: World, clients: number): Promise<FakeSocket[]> {
	const requesters = Array.from({ length: clients }, () => w.cli());
	for (const [client, requester] of requesters.entries())
		for (let i = 0; i < 4; i++)
			await w.post(requester, protoRequest({ requestId: `c${client}-${i}` }));
	return requesters;
}

describe("proto relay bytes", () => {
	it("sends the pinned browser request and CLI result bytes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, {
			type: "cli-proto-request",
			requestId: "r-1",
			phase: "scrape",
			slug: PROTO_SLUG,
			markedUrl: PROTO_URL,
			timeoutMs: 1000,
		});
		expect(ext.send.mock.calls).toHaveLength(1);
		expect(ext.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "proto-browser-request",
				sessionId: w.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
				requestId: "r-1",
				phase: "scrape",
				slug: PROTO_SLUG,
				markedUrl: PROTO_URL,
				timeoutMs: 1000,
			}),
		);
		await w.post(ext, protoReply(w, "r-1"));
		await until(() => cli.send.mock.calls.length === 1);
		expect(cli.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "cli-proto-result",
				sessionId: w.sessionId,
				requestId: "r-1",
				ok: true,
				data: PROTO_DATA,
			}),
		);
	});

	it("sends the phase default as the deadline when the CLI names none", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "r-1", timeoutMs: undefined }));
		expect(sentOfType(ext, "proto-browser-request")[0]).toMatchObject({
			timeoutMs: 45_000,
		});
	});

	it("sends a not-ready result with no error key", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "r-1", phase: "plant" }));
		await w.post(
			ext,
			protoReply(w, "r-1", {
				ok: false,
				data: undefined,
				notReady: PROTO_NOT_READY,
			}),
		);
		await until(() => cli.send.mock.calls.length === 1);
		expect(cli.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "cli-proto-result",
				sessionId: w.sessionId,
				requestId: "r-1",
				ok: false,
				notReady: PROTO_NOT_READY,
			}),
		);
	});

	it("sends a failed extension result as an error result", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "r-1" }));
		await w.post(
			ext,
			protoReply(w, "r-1", { ok: false, data: undefined, error: "expired" }),
		);
		await until(() => cli.send.mock.calls.length === 1);
		expect(cli.send.mock.calls[0]?.[0]).toBe(
			JSON.stringify({
				type: "cli-proto-result",
				sessionId: w.sessionId,
				requestId: "r-1",
				ok: false,
				error: "expired",
			}),
		);
	});

	it("delivers a result only to the requesting CLI", async () => {
		const w = await world();
		const cli = w.cli();
		const other = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "r-1" }));
		await w.post(ext, protoReply(w, "r-1"));
		await until(() => protoResults(cli).length === 1);
		await quiet();
		expect(other.send.mock.calls).toHaveLength(0);
		expect(w.store.claimNext(w.sessionId)).toBeUndefined();
	});
});

describe("proto relay check order", () => {
	it("answers the active refusal before the duplicate drop", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		await w.post(cli, protoRequest({ requestId: "a" }));
		const record = w.registry.get(w.sessionId);
		if (!record) throw new Error("session missing");
		record.state = "closed";
		await w.post(cli, protoRequest({ requestId: "a" }));
		expect(protoResults(cli)).toMatchObject([
			{ ok: false, error: PROTO_REFUSAL.active },
		]);
	});

	it("answers duplicate requestId for a pending id even when the other socket has 4 pending", async () => {
		const w = await world();
		const owner = w.cli();
		const other = w.cli();
		w.extension();
		await w.post(owner, protoRequest({ requestId: "taken" }));
		for (let i = 0; i < 4; i++)
			await w.post(other, protoRequest({ requestId: `o${i}` }));
		await w.post(other, protoRequest({ requestId: "taken" }));
		expect(protoResults(other)).toMatchObject([
			{ ok: false, error: "duplicate requestId" },
		]);
		expect(protoResults(owner)).toEqual([]);
	});

	it("answers the replay refusal before the requester cap", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await protoSettled(w, cli, ext, "used");
		for (let i = 0; i < 4; i++)
			await w.post(cli, protoRequest({ requestId: `p${i}` }));
		await w.post(cli, protoRequest({ requestId: "used" }));
		expect(protoResults(cli)).toHaveLength(2);
		expect(protoResults(cli)[1]).toMatchObject({
			ok: false,
			error: PROTO_REFUSAL.used,
		});
	});

	it("answers the requester cap before the pending cap", async () => {
		const w = await world();
		w.extension();
		const requesters = await protoFillPending(w, 8);
		const first = requesters[0] as FakeSocket;
		await w.post(first, protoRequest({ requestId: "fresh" }));
		expect(protoResults(first)).toMatchObject([
			{ ok: false, error: PROTO_REFUSAL.tooMany },
		]);
	});

	it("answers the pending cap before the peers refusal", async () => {
		const w = await world();
		w.extension();
		await protoFillPending(w, 8);
		const other = w.registry.create({
			cwd: w.dgHome,
			agentIdentity: "other",
			role: "agent",
		});
		const extra = w.cli({ capabilities: [[other.sessionId, other.token]] });
		const relay = createBrowserRelay({ deps: w.deps, feature: PROTO_RELAY });
		await relay.handleRequest(extra, other.sessionId, {
			type: "cli-proto-request",
			requestId: "fresh",
			phase: "scrape",
			slug: PROTO_SLUG,
			markedUrl: PROTO_URL,
		});
		expect(protoResults(extra)).toMatchObject([
			{ ok: false, error: PROTO_REFUSAL.capacity },
		]);
	});

	it("answers the no-peer refusal with the pairing hint and the multiple-peers refusal", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, protoRequest({ requestId: "a" }));
		w.extension();
		w.extension();
		await w.post(cli, protoRequest({ requestId: "b" }));
		expect(protoResults(cli)).toMatchObject([
			{ ok: false, error: PROTO_REFUSAL.noPeer(w.sessionId) },
			{ ok: false, error: PROTO_REFUSAL.multiple },
		]);
	});

	it("refuses zero or several extension peers without a browser request", async () => {
		for (const count of [0, 2]) {
			const w = await world();
			const cli = w.cli();
			const peers = Array.from({ length: count }, () => w.extension());
			await w.post(cli, protoRequest());
			expect(protoResults(cli)).toHaveLength(1);
			for (const peer of peers)
				expect(sentOfType(peer, "proto-browser-request")).toEqual([]);
		}
	});

	it("accepts any extension version", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension("0.0.1");
		await w.post(cli, protoRequest({ requestId: "r-1" }));
		expect(sentOfType(ext, "proto-browser-request")).toHaveLength(1);
	});
});

describe("proto relay duplicates", () => {
	it("drops a pending id resent by the same requester without an answer", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "a" }));
		await w.post(cli, protoRequest({ requestId: "a" }));
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
		expect(sentOfType(ext, "proto-browser-request")).toHaveLength(1);
	});

	it("refuses a pending id resent by another CLI without replacing the original", async () => {
		const w = await world();
		const cli = w.cli();
		const other = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "a" }));
		await w.post(other, protoRequest({ requestId: "a", markedUrl: "https://example.test/other#x" }));
		expect(protoResults(other)).toMatchObject([
			{ ok: false, error: "duplicate requestId" },
		]);
		await w.post(ext, protoReply(w, "a"));
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({ ok: true, data: PROTO_DATA });
	});
});

describe("proto relay replay guard", () => {
	it("refuses a resend of an id that already settled", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await protoSettled(w, cli, ext, "a");
		await w.post(cli, protoRequest({ requestId: "a" }));
		expect(protoResults(cli)[1]).toMatchObject({
			ok: false,
			error: PROTO_REFUSAL.used,
		});
		expect(sentOfType(ext, "proto-browser-request")).toHaveLength(1);
	});

	it("forwards the id again after the session emits closed and refuses after a real close", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await protoSettled(w, cli, ext, "a");
		w.deps.registry.emit("closed", { sessionId: w.sessionId, reason: "closed" });
		await w.post(cli, protoRequest({ requestId: "a" }));
		expect(sentOfType(ext, "proto-browser-request")).toHaveLength(2);
		w.registry.close(w.sessionId, "cli");
		await w.post(cli, protoRequest({ requestId: "a" }));
		expect(protoResults(cli).at(-1)).toMatchObject({
			ok: false,
			error: PROTO_REFUSAL.active,
		});
	});

	it("lets a request refused for no peer or for several peers be resent with the same id", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, protoRequest({ requestId: "a" }));
		const first = w.extension();
		const second = w.extension();
		await w.post(cli, protoRequest({ requestId: "a" }));
		expect(protoResults(cli)[1]).toMatchObject({ error: PROTO_REFUSAL.multiple });
		w.connections.remove(second);
		await w.post(cli, protoRequest({ requestId: "a" }));
		expect(sentOfType(first, "proto-browser-request")).toHaveLength(1);
		expect(protoResults(cli)).toHaveLength(2);
	});

	it("refuses the fourth distinct id on a small table", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		const relay = createBrowserRelay({
			deps: w.deps,
			feature: {
				...PROTO_RELAY,
				caps: { ...PROTO_RELAY.caps, sessionIds: 3 },
			},
		});
		const request = (requestId: string) =>
			relay.handleRequest(cli, w.sessionId, {
				type: "cli-proto-request",
				requestId,
				phase: "scrape",
				slug: PROTO_SLUG,
				markedUrl: PROTO_URL,
			});
		for (const requestId of ["a", "b", "c"]) {
			await request(requestId);
			relay.handleResult(ext, {
				sessionId: w.sessionId,
				requestId,
				ok: true,
				data: PROTO_DATA as never,
			});
		}
		await request("d");
		expect(protoResults(cli).at(-1)).toMatchObject({
			ok: false,
			error: PROTO_REFUSAL.capacity,
		});
	});

	it("refuses a resend after a throwing send", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		rejectSends(ext);
		await w.post(cli, protoRequest({ requestId: "a" }));
		await until(() => protoResults(cli).length === 1);
		await w.post(cli, protoRequest({ requestId: "a" }));
		expect(protoResults(cli)[1]).toMatchObject({ error: PROTO_REFUSAL.used });
	});

	it("refuses the fifth pending request from one requester across two sessions", async () => {
		const w = await world();
		const cli = w.cli();
		const other = w.registry.create({
			cwd: w.dgHome,
			agentIdentity: "other",
			role: "agent",
		});
		w.connections.add(
			fakeSocket("ws", {
				extensionVersion: MIN_VERSION,
				capabilities: [[other.sessionId, other.token]],
			}),
		);
		w.extension();
		const relay = createBrowserRelay({ deps: w.deps, feature: PROTO_RELAY });
		const request = (sessionId: string, requestId: string) =>
			relay.handleRequest(cli, sessionId, {
				type: "cli-proto-request",
				requestId,
				phase: "scrape",
				slug: PROTO_SLUG,
				markedUrl: PROTO_URL,
			});
		for (let i = 0; i < 2; i++) {
			await request(w.sessionId, `a${i}`);
			await request(other.sessionId, `b${i}`);
		}
		await request(w.sessionId, "fifth");
		expect(protoResults(cli)).toMatchObject([
			{ ok: false, error: PROTO_REFUSAL.tooMany },
		]);
	});
});

describe("proto relay timeout text", () => {
	it("reports the last progress report from the owning extension", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "a", timeoutMs: 250 }));
		await w.post(ext, {
			type: "proto-browser-progress",
			sessionId: w.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			token: w.token,
			requestId: "a",
			status: "loading",
		});
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: false,
			error: "Prototype scrape timed out after 250ms; last report from the extension: loading.",
		});
	});

	it("names the missing report and the page without its hash", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		await w.post(cli, protoRequest({ requestId: "a", timeoutMs: 20 }));
		await until(() => protoResults(cli).length === 1);
		const error = String(protoResults(cli)[0]?.error);
		expect(error).toContain("timed out after 20ms with no report from the extension");
		expect(error).toContain("https://example.test/account in a paired browser");
		expect(error).not.toContain("#_proto=");
	});

	it("ignores progress from a socket that does not own the request", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		const other = w.extension();
		w.connections.remove(other);
		await w.post(cli, protoRequest({ requestId: "a", timeoutMs: 30 }));
		await w.post(other, {
			type: "proto-browser-progress",
			sessionId: w.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			token: w.token,
			requestId: "a",
			status: "forged",
		});
		await until(() => protoResults(cli).length === 1);
		expect(String(protoResults(cli)[0]?.error)).toContain("no report from the extension");
	});

	it("expires a request, ignores its late reply and accepts the next request", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "a", timeoutMs: 20 }));
		await until(() => protoResults(cli).length === 1);
		await w.post(ext, protoReply(w, "a"));
		await w.post(cli, protoRequest({ requestId: "b" }));
		await w.post(ext, protoReply(w, "b"));
		await until(() => protoResults(cli).length === 2);
		expect(protoResults(cli)[1]).toMatchObject({ requestId: "b", ok: true });
	});
});

describe("proto relay unreadable results", () => {
	async function pending(count = 1) {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		for (let i = 1; i <= count; i++)
			await w.post(cli, protoRequest({ requestId: `r-${i}` }));
		return { w, cli, ext };
	}

	it("delivers the verdict without the preview when the preview made the result oversized", async () => {
		const { w, cli, ext } = await pending();
		const raw = oversizedPreviewReply(w, "r-1");
		expect(Buffer.byteLength(raw)).toBeGreaterThan(CHAT_MAX_PAYLOAD_BYTES);
		expect(Buffer.byteLength(raw)).toBeLessThan(
			CHAT_MAX_PAYLOAD_BYTES + WS_PAYLOAD_HEADROOM_BYTES,
		);
		await w.postRaw(ext, raw);
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: true,
			data: { kind: "verdict", verdict: PROTO_VERDICT },
		});
		expect(JSON.stringify(protoResults(cli)[0])).not.toContain("previewDataUrl");
		expect(sentOfType(ext, "error")).toEqual([]);
		expect(ext.data.invalidFrameCount).toBe(0);
	});

	it("settles with the rejected text when the result is still invalid after the strip", async () => {
		const { w, cli, ext } = await pending();
		const raw = oversizedPreviewReply(w, "r-1", { extra: true });
		await w.postRaw(ext, raw);
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: false,
			error: PROTO_END.rejected("unknown proto result field"),
		});
		expect(sentOfType(ext, "error")).toEqual([]);
		expect(ext.data.invalidFrameCount).toBe(0);
	});

	it("fails every pending request for an unreadable oversized payload and strikes the extension", async () => {
		const { w, cli, ext } = await pending(2);
		const raw = "x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1);
		await w.postRaw(ext, raw);
		await until(() => protoResults(cli).length === 2);
		for (const result of protoResults(cli))
			expect(result).toMatchObject({ ok: false, error: PROTO_END.unreadable });
		expect(sentOfType(ext, "error")).toMatchObject([
			{ message: oversizeMessage(raw) },
		]);
		expect(ext.data.invalidFrameCount).toBe(1);
	});

	it("fails the other pending requests of the socket for an oversized result that matches none", async () => {
		const { w, cli, ext } = await pending(2);
		const raw = oversizedPreviewReply(w, "unknown-id");
		await w.postRaw(ext, raw);
		await until(() => protoResults(cli).length === 2);
		for (const result of protoResults(cli))
			expect(result).toMatchObject({ ok: false, error: PROTO_END.unreadable });
		expect(sentOfType(ext, "error")).toMatchObject([
			{ message: oversizeMessage(raw) },
		]);
		expect(ext.data.invalidFrameCount).toBe(1);
	});

	it("settles with the rejected text when an invalid result reaches the extension socket", async () => {
		const { w, cli, ext } = await pending();
		await w.post(ext, protoReply(w, "r-1", { extra: true }));
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: false,
			error: PROTO_END.rejected("unknown proto result field"),
		});
		expect(sentOfType(ext, "error")).toEqual([]);
		expect(ext.data.invalidFrameCount).toBe(0);
	});

	it("reports a protocol version mismatch found while salvaging an oversized result", async () => {
		const { w, cli, ext } = await pending();
		await w.postRaw(ext, oversizedPreviewReply(w, "r-1", { protocolVersion: 2 }));
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			error: PROTO_END.rejected(
				`protocol version mismatch: daemon expects ${CHAT_PROTOCOL_VERSION}`,
			),
		});
	});

	it("leaves a normal-size result with a wrong protocol version to the general error", async () => {
		const { w, cli, ext } = await pending();
		await w.post(ext, protoReply(w, "r-1", { protocolVersion: 2 }));
		await quiet();
		expect(protoResults(cli)).toEqual([]);
		expect(sentOfType(ext, "error")).toHaveLength(1);
		expect(ext.data.invalidFrameCount).toBe(1);
	});

	it("authorizes the token inside salvage and settles with the authorization message", async () => {
		const { w, cli, ext } = await pending();
		await w.postRaw(ext, oversizedPreviewReply(w, "r-1", { token: "forged-token" }));
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: false,
			error: PROTO_END.rejected(
				`session ${w.sessionId} is not authorized for this frame`,
			),
		});
	});

	it("settles with the rejected text when the oversized result carries no token", async () => {
		const { w, cli, ext } = await pending();
		await w.postRaw(ext, oversizedPreviewReply(w, "r-1", { token: undefined }));
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: false,
			error: PROTO_END.rejected(
				'chat frame.token must be a non-empty string',
			),
		});
	});

	it("leaves pending inbox and pw-ext requests alone when an extension sends an unreadable payload", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, inboxRequest({ requestId: "i-1" }));
		await w.post(cli, pwRequest({ requestId: "p-1" }));
		await w.postRaw(ext, "x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1));
		await quiet();
		expect(inboxResults(cli)).toEqual([]);
		expect(cliResults(cli)).toEqual([]);
		expect(ext.data.invalidFrameCount).toBe(1);
	});

	it("fails nothing for an unreadable payload from a CLI socket", async () => {
		const { w, cli } = await pending();
		await w.postRaw(cli, "x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1));
		await quiet();
		expect(protoResults(cli)).toEqual([]);
		expect(cli.data.invalidFrameCount).toBe(1);
	});

	it("settles nothing for an oversized result from a second extension socket and strikes it", async () => {
		const { w, cli } = await pending();
		const second = w.extension();
		const raw = oversizedPreviewReply(w, "r-1");
		await w.postRaw(second, raw);
		await quiet();
		expect(protoResults(cli)).toEqual([]);
		expect(sentOfType(second, "error")).toMatchObject([
			{ message: oversizeMessage(raw) },
		]);
		expect(second.data.invalidFrameCount).toBe(1);
	});
});

describe("proto relay result ownership", () => {
	async function pending() {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "r-1" }));
		return { w, cli, ext };
	}

	it("ignores a result from a second extension socket and from a page socket", async () => {
		const { w, cli } = await pending();
		await w.post(w.extension(), protoReply(w, "r-1"));
		await w.post(w.page(), protoReply(w, "r-1"));
		await quiet();
		expect(protoResults(cli)).toEqual([]);
	});

	it("ignores a result for another request or with a wrong token", async () => {
		const { w, cli, ext } = await pending();
		await w.post(ext, protoReply(w, "wrong-request-id"));
		await w.post(ext, protoReply(w, "r-1", { token: "forged-token" }));
		await quiet();
		expect(protoResults(cli)).toEqual([]);
		await w.post(ext, protoReply(w, "r-1"));
		await until(() => protoResults(cli).length === 1);
	});

	it("ignores a second result for a settled request", async () => {
		const { w, cli, ext } = await pending();
		await w.post(ext, protoReply(w, "r-1"));
		await w.post(ext, protoReply(w, "r-1"));
		await quiet();
		expect(protoResults(cli)).toHaveLength(1);
	});

	it("refreshes the session activity before it handles a result", async () => {
		const { w, ext } = await pending();
		const record = w.registry.get(w.sessionId);
		if (!record) throw new Error("session missing");
		record.lastActivityAt = 0;
		await w.post(ext, protoReply(w, "r-1"));
		expect(record.lastActivityAt).toBeGreaterThan(0);
	});
});

describe("proto relay ends", () => {
	it("sends nothing to anyone when the requester closes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "a" }));
		abortPendingWork(cli);
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
		expect(sentFrames(ext).map((frame) => frame.type)).toEqual([
			"proto-browser-request",
		]);
		await w.post(ext, protoReply(w, "a"));
		await quiet();
		expect(cli.send.mock.calls).toHaveLength(0);
	});

	it("answers when the extension closes", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "a" }));
		abortPendingWork(ext);
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: false,
			error: PROTO_END.extension,
		});
	});

	it("answers when the session closes", async () => {
		const w = await world();
		const cli = w.cli();
		w.extension();
		await w.post(cli, protoRequest({ requestId: "a" }));
		w.deps.registry.emit("closed", { sessionId: w.sessionId, reason: "closed" });
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: false,
			error: PROTO_END.closed,
		});
	});

	it("answers when the extension send fails", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		rejectSends(ext);
		await w.post(cli, protoRequest({ requestId: "a" }));
		await until(() => protoResults(cli).length === 1);
		expect(protoResults(cli)[0]).toMatchObject({
			ok: false,
			error: PROTO_END.sendFailed,
		});
	});

	it("sends no cancel frame to the extension on a timeout or a requester close", async () => {
		const w = await world();
		const cli = w.cli();
		const closing = w.cli();
		const ext = w.extension();
		await w.post(cli, protoRequest({ requestId: "a", timeoutMs: 20 }));
		await w.post(closing, protoRequest({ requestId: "b" }));
		abortPendingWork(closing);
		await until(() => protoResults(cli).length === 1);
		expect(sentFrames(ext).map((frame) => frame.type)).toEqual([
			"proto-browser-request",
			"proto-browser-request",
		]);
	});
});

describe("proto relay settled outcome", () => {
	it("settles a delivered not-ready result with kind error carrying the result", async () => {
		const w = await world();
		const cli = w.cli();
		const ext = w.extension();
		const outcomes: RelayOutcome[] = [];
		const relay = createBrowserRelay({
			deps: w.deps,
			feature: PROTO_RELAY,
			hooks: { settled: ({ outcome }) => outcomes.push(outcome) },
		});
		await relay.handleRequest(cli, w.sessionId, {
			type: "cli-proto-request",
			requestId: "a",
			phase: "plant",
			slug: PROTO_SLUG,
			markedUrl: PROTO_URL,
		});
		relay.handleResult(ext, {
			sessionId: w.sessionId,
			requestId: "a",
			ok: false,
			notReady: PROTO_NOT_READY,
		});
		const expected = {
			kind: "error",
			result: { ok: false, notReady: PROTO_NOT_READY },
		} satisfies RelayOutcome;
		expect(outcomes).toEqual([expected]);
	});

	it("slices the rejected text to exactly 2048 characters", () => {
		expect(PROTO_RELAY.strings.rejected?.("x".repeat(5000))).toHaveLength(2048);
	});
});

describe("proto relay salvage hook", () => {
	it("repairs a frame without throwing for a socket that holds the token", async () => {
		const w = await world();
		const ext = w.extension();
		const raw = JSON.parse(oversizedPreviewReply(w, "a")) as Record<string, unknown>;
		const frame = protoRelayHooks().salvage?.({ raw, socket: ext });
		expect(frame).toMatchObject({
			type: "proto-browser-result",
			requestId: "a",
			data: { kind: "verdict", verdict: PROTO_VERDICT },
		});
		expect(JSON.stringify(frame)).not.toContain("previewDataUrl");
	});

	it("rejects a result that changed type", async () => {
		const w = await world();
		const ext = w.extension();
		const raw = {
			type: "proto-browser-progress",
			sessionId: w.sessionId,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			token: w.token,
			requestId: "a",
			status: "x",
		};
		expect(() => protoRelayHooks().salvage?.({ raw, socket: ext })).toThrow(
			"prototype result changed type",
		);
	});
});

describe("proto relay invalid CLI frames", () => {
	it("answers an invalid request with the validator message and one strike, send first", async () => {
		const strikes: number[] = [];
		const w = await world();
		const cli = w.cli({
			send: mock((_payload: string) => strikes.push(cli.data.invalidFrameCount)),
		});
		await w.post(cli, protoRequest({ requestId: "r-1", phase: "nope" }));
		expect(protoResults(cli)).toMatchObject([
			{
				sessionId: w.sessionId,
				requestId: "r-1",
				ok: false,
				error: 'proto cli request.phase must be "scrape" or "plant"',
			},
		]);
		expect(strikes).toEqual([0]);
		expect(cli.data.invalidFrameCount).toBe(1);
	});

	it("answers with invalid-request when the id is too long", async () => {
		const w = await world();
		const cli = w.cli();
		await w.post(cli, protoRequest({ requestId: "x".repeat(129), phase: "nope" }));
		expect(protoResults(cli)[0]).toMatchObject({
			requestId: "invalid-request",
			ok: false,
		});
	});
});
