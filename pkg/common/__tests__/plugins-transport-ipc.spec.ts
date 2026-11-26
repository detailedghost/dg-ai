import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFrame, encodeFrame, FRAME_FLAG_ERROR, FRAME_FLAG_RESPONSE, type Frame } from "../src/plugins/contract";
import { FrameReader } from "../src/plugins/transport/framing";
import { assertSocketPrivate, closeIpcConnections, connectIpc, getIpcConnection, ipcEndpoint, windowsPipePath } from "../src/plugins/transport/ipc";

type FrameFixture = { name: string; encoding: number; flags: number; requestId: number; payloadText?: string; payloadHex?: string; hex: string };
type InvalidFixture = { name: string; error: string; hex: string };

const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/plugins/frames/frames.json"), "utf8")) as {
	valid: FrameFixture[];
	invalid: InvalidFixture[];
};

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const payloadOf = (fixture: FrameFixture) => (fixture.payloadText !== undefined ? new TextEncoder().encode(fixture.payloadText) : fromHex(fixture.payloadHex ?? ""));
const frameOf = (fixture: FrameFixture): Frame => ({
	encoding: fixture.encoding === 0 ? "json" : "msgpack",
	flags: fixture.flags,
	requestId: fixture.requestId,
	payload: payloadOf(fixture),
});

const dirs: string[] = [];
const servers: Server[] = [];

function socketPath(): string {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dg-ipc-"));
	dirs.push(dir);
	return join(dir, "p.sock");
}

type Handler = (route: string, body: unknown, frame: Frame, reply: (frame: Frame) => void) => void;

async function startPlugin(path: string, handler: Handler, mode = 0o600): Promise<void> {
	const server = createServer((socket: Socket) => {
		const reader = new FrameReader();
		socket.on("data", (chunk: Buffer) => {
			for (const frame of reader.push(chunk)) {
				const message = JSON.parse(new TextDecoder().decode(frame.payload)) as { route: string; body: unknown };
				handler(message.route, message.body, frame, (out) => socket.write(encodeFrame(out)));
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(path, resolve));
	chmodSync(path, mode);
}

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const respond = (frame: Frame, body: unknown, flags = FRAME_FLAG_RESPONSE): Frame => ({ encoding: "json", flags, requestId: frame.requestId, payload: json(body) });

const helloOk = { protocol: 1, encoding: "json", capabilities: ["hook"] };

afterEach(async () => {
	closeIpcConnections();
	for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("frame fixtures", () => {
	test.each(fixtures.valid.map((fixture) => [fixture.name, fixture] as const))("encode and decode match %s byte for byte", (_name, fixture) => {
		expect(toHex(encodeFrame(frameOf(fixture)))).toBe(fixture.hex);
		const decoded = decodeFrame(fromHex(fixture.hex));
		expect(decoded.requestId).toBe(fixture.requestId);
		expect(decoded.flags).toBe(fixture.flags);
		expect(toHex(decoded.payload)).toBe(toHex(payloadOf(fixture)));
	});

	test("the stream reader splits every valid fixture glued into one buffer", () => {
		const glued = Buffer.concat(fixtures.valid.map((fixture) => Buffer.from(fixture.hex, "hex")));
		const frames = new FrameReader().push(new Uint8Array(glued));
		expect(frames.map((frame) => frame.requestId)).toEqual(fixtures.valid.map((fixture) => fixture.requestId));
		expect(frames.map((frame) => toHex(encodeFrame(frame)))).toEqual(fixtures.valid.map((fixture) => fixture.hex));
	});

	test("the stream reader rebuilds frames fed one byte at a time", () => {
		const reader = new FrameReader();
		const glued = Buffer.concat(fixtures.valid.map((fixture) => Buffer.from(fixture.hex, "hex")));
		const seen: string[] = [];
		for (const byte of glued) for (const frame of reader.push(Uint8Array.of(byte))) seen.push(toHex(encodeFrame(frame)));
		expect(seen).toEqual(fixtures.valid.map((fixture) => fixture.hex));
	});

	test("the stream reader waits when the payload is incomplete", () => {
		const reader = new FrameReader();
		expect(reader.push(fromHex("0100000000000001000000057b"))).toEqual([]);
	});

	test.each(
		fixtures.invalid.filter((fixture) => fixture.error !== "truncated-payload" && fixture.error !== "trailing-bytes" && fixture.error !== "short-header").map((fixture) => [fixture.name, fixture] as const),
	)("the stream reader rejects %s", (_name, fixture) => {
		expect(() => new FrameReader().push(fromHex(fixture.hex))).toThrow(`frame ${fixture.error}`);
	});

	test("the stream reader rejects an oversize length before the payload arrives", () => {
		expect(() => new FrameReader().push(fromHex("010000000000000100100001"))).toThrow("frame oversize");
	});
});

describe("socket permissions", () => {
	test("accepts a socket with mode 0600", async () => {
		const path = socketPath();
		await startPlugin(path, () => {});
		expect(() => assertSocketPrivate(path)).not.toThrow();
	});

	test.each([0o660, 0o666, 0o700, 0o602])("refuses a socket file with mode %o", async (mode) => {
		const path = socketPath();
		await startPlugin(path, () => {}, mode);
		expect(() => assertSocketPrivate(path)).toThrow("permissions");
	});

	test("refuses a path that is not a socket", () => {
		const path = socketPath();
		expect(() => assertSocketPrivate(path)).toThrow(path);
	});

	test("connectIpc refuses a world-writable socket without connecting", async () => {
		const path = socketPath();
		let connections = 0;
		await startPlugin(
			path,
			() => {
				connections += 1;
			},
			0o666,
		);
		await expect(connectIpc(path)).rejects.toThrow("permissions");
		expect(connections).toBe(0);
	});
});

describe("IPC connection", () => {
	test("sends hello first, then a hook decide round-trips", async () => {
		const path = socketPath();
		const seen: string[] = [];
		await startPlugin(path, (route, body, frame, reply) => {
			seen.push(route);
			if (route === "/v1/hello") reply(respond(frame, helloOk));
			else reply(respond(frame, { decision: "allow", reason: JSON.stringify(body) }));
		});
		const connection = await connectIpc(path);
		const result = await connection.request("/v1/hook/decide", { event: "PreToolUse", tool: "Bash" });
		expect(result).toEqual({ decision: "allow", reason: '{"event":"PreToolUse","tool":"Bash"}' });
		expect(seen).toEqual(["/v1/hello", "/v1/hook/decide"]);
		connection.close();
	});

	test("matches out-of-order responses to their request ids", async () => {
		const path = socketPath();
		const held: Frame[] = [];
		await startPlugin(path, (route, _body, frame, reply) => {
			if (route === "/v1/hello") return reply(respond(frame, helloOk));
			held.push(frame);
			if (held.length === 2) {
				reply(respond(held[1], { decision: "deny" }));
				reply(respond(held[0], { decision: "allow" }));
			}
		});
		const connection = await connectIpc(path);
		const [first, second] = await Promise.all([connection.request("/v1/hook/decide", { event: "a" }), connection.request("/v1/hook/decide", { event: "b" })]);
		expect(first).toEqual({ decision: "allow" });
		expect(second).toEqual({ decision: "deny" });
		expect(new Set(held.map((frame) => frame.requestId)).size).toBe(2);
		connection.close();
	});

	test("rejects with the plugin code and message on an error response", async () => {
		const path = socketPath();
		await startPlugin(path, (route, _body, frame, reply) => {
			if (route === "/v1/hello") return reply(respond(frame, helloOk));
			reply(respond(frame, { code: "bad-request", message: "body is not an object" }, FRAME_FLAG_RESPONSE | FRAME_FLAG_ERROR));
		});
		const connection = await connectIpc(path);
		await expect(connection.request("/v1/hook/decide", { event: "a" })).rejects.toThrow("bad-request: body is not an object");
		connection.close();
	});

	test("rejects a request body that breaks the route contract before it hits the wire", async () => {
		const path = socketPath();
		const seen: string[] = [];
		await startPlugin(path, (route, _body, frame, reply) => {
			seen.push(route);
			reply(respond(frame, helloOk));
		});
		const connection = await connectIpc(path);
		await expect(connection.request("/v1/hook/decide", {})).rejects.toThrow("body.event");
		expect(seen).toEqual(["/v1/hello"]);
		connection.close();
	});

	test("times out a silent plugin and still answers the next request", async () => {
		const path = socketPath();
		let calls = 0;
		await startPlugin(path, (route, _body, frame, reply) => {
			if (route === "/v1/hello") return reply(respond(frame, helloOk));
			calls += 1;
			if (calls > 1) reply(respond(frame, { decision: "allow" }));
		});
		const connection = await connectIpc(path);
		await expect(connection.request("/v1/hook/decide", { event: "a" }, 50)).rejects.toThrow("timed out");
		await expect(connection.request("/v1/hook/decide", { event: "b" })).resolves.toEqual({ decision: "allow" });
		connection.close();
	});

	test("rejects pending requests when the plugin hangs up", async () => {
		const path = socketPath();
		let socketRef: Socket | undefined;
		const server = createServer((socket) => {
			socketRef = socket;
			const reader = new FrameReader();
			socket.on("data", (chunk: Buffer) => {
				for (const frame of reader.push(chunk)) {
					const message = JSON.parse(new TextDecoder().decode(frame.payload)) as { route: string };
					if (message.route === "/v1/hello") socket.write(encodeFrame(respond(frame, helloOk)));
					else socket.destroy();
				}
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(path, resolve));
		chmodSync(path, 0o600);
		const connection = await connectIpc(path);
		await expect(connection.request("/v1/hook/decide", { event: "a" })).rejects.toThrow("closed");
		expect(socketRef).toBeDefined();
		await expect(connection.request("/v1/hook/decide", { event: "b" })).rejects.toThrow("closed");
	});

	test("rejects a hello answer that names another protocol", async () => {
		const path = socketPath();
		await startPlugin(path, (_route, _body, frame, reply) => reply(respond(frame, { ...helloOk, protocol: 2 })));
		await expect(connectIpc(path)).rejects.toThrow("body.protocol");
	});

	test("rejects a connection to a missing socket with a next step", async () => {
		await expect(connectIpc(socketPath())).rejects.toThrow("Next:");
	});
});

describe("warm connection per plugin", () => {
	test("reuses one connection for repeated calls to the same plugin", async () => {
		const path = socketPath();
		let hellos = 0;
		await startPlugin(path, (route, _body, frame, reply) => {
			if (route === "/v1/hello") {
				hellos += 1;
				return reply(respond(frame, helloOk));
			}
			reply(respond(frame, { decision: "allow" }));
		});
		const first = await getIpcConnection("secret-scan", path);
		const second = await getIpcConnection("secret-scan", path);
		expect(second).toBe(first);
		await first.request("/v1/hook/decide", { event: "a" });
		await second.request("/v1/hook/decide", { event: "b" });
		expect(hellos).toBe(1);
	});

	test("opens a new connection after the warm one closes", async () => {
		const path = socketPath();
		await startPlugin(path, (_route, _body, frame, reply) => reply(respond(frame, helloOk)));
		const first = await getIpcConnection("p", path);
		first.close();
		const second = await getIpcConnection("p", path);
		expect(second).not.toBe(first);
	});

	test("shares one in-flight connect between concurrent callers", async () => {
		const path = socketPath();
		let hellos = 0;
		await startPlugin(path, (_route, _body, frame, reply) => {
			hellos += 1;
			reply(respond(frame, helloOk));
		});
		const [a, b] = await Promise.all([getIpcConnection("p", path), getIpcConnection("p", path)]);
		expect(a).toBe(b);
		expect(hellos).toBe(1);
	});
});

describe("reconnect after a failed warm attempt", () => {
	test("shares one replacement connection between concurrent callers", async () => {
		const path = socketPath();
		let hellos = 0;
		await startPlugin(path, (_route, _body, frame, reply) => {
			hellos += 1;
			reply(respond(frame, helloOk));
		});
		const failed = getIpcConnection("p", socketPath());
		const [a, b] = await Promise.all([getIpcConnection("p", path), getIpcConnection("p", path)]);
		await expect(failed).rejects.toThrow("Next:");
		expect(a).toBe(b);
		expect(hellos).toBe(1);
	});
});

describe("endpoint paths", () => {
	test("puts a relative socket name under the plugin directory on Unix", () => {
		expect(ipcEndpoint("secret-scan", "/home/u/plugins/secret-scan", "secret-scan.sock", "linux")).toBe("/home/u/plugins/secret-scan/secret-scan.sock");
	});

	test.each(["../x.sock", "a/b.sock", "/tmp/x.sock", "a\\b.sock", "..", "."])("refuses the endpoint %s on Unix", (endpoint) => {
		expect(() => ipcEndpoint("secret-scan", "/home/u/plugins/secret-scan", endpoint, "linux")).toThrow("plain file name");
	});

	test("maps a plugin name to a named pipe path on Windows", () => {
		expect(windowsPipePath("secret-scan")).toBe("\\\\.\\pipe\\dg-plugin-secret-scan");
		expect(ipcEndpoint("secret-scan", "C:\\plugins\\secret-scan", "secret-scan.sock", "win32")).toBe("\\\\.\\pipe\\dg-plugin-secret-scan");
	});
});
