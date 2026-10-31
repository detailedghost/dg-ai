import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { connectJsonRpc } from "../src/signal/rpc";
import { daemonArgs, startSignalDaemon, type Spawned } from "../src/signal/daemon";
import { messageFromEnvelope } from "../src/signal/envelope";
import { startFakeSignalServer } from "./support/rpc";

describe("signal JSON-RPC client", () => {
	test("matches responses by id and redacts secrets in errors", async () => {
		const server = await startFakeSignalServer((method) => {
			if (method === "listAccounts") return [{ aci: "acct-1", number: "+15555550123" }];
			throw new Error("failed for +15555550199 sgnl://linkdevice?uuid=abc&pub_key=SECRET");
		});
		const rpc = await connectJsonRpc(server.port);
		expect(await rpc.call("listAccounts", {}, 1000)).toEqual([
			{ aci: "acct-1", number: "+15555550123" },
		]);
		await expect(rpc.call("send", { message: "nope" }, 1000)).rejects.toThrow("[phone]");
		const message = await rpc.call("send", { message: "nope" }, 1000).catch((error: Error) => error.message);
		expect(message).not.toContain("+15555550199");
		expect(message).not.toContain("sgnl://");
		expect(message).not.toContain("SECRET");
		await rpc.close();
		await server.close();
	});

	test("queues receive notifications separately from results", async () => {
		const server = await startFakeSignalServer(() => ({ ok: true }));
		server.push("receive", { envelope: { sourceUuid: "u2", dataMessage: { message: "ping", timestamp: 4 } } });
		const rpc = await connectJsonRpc(server.port);
		expect(await rpc.call("receive", { account: "acct-1" }, 1000)).toEqual({ ok: true });
		expect(rpc.drainNotifications()).toEqual([
			{
				method: "receive",
				params: { envelope: { sourceUuid: "u2", dataMessage: { message: "ping", timestamp: 4 } } },
			},
		]);
		expect(rpc.drainNotifications()).toEqual([]);
		await rpc.close();
		await server.close();
	});
});

function fakeChild(stderrText = ""): Spawned & { killed: boolean } {
	const child = {
		killed: false,
		kill() {
			child.killed = true;
		},
		exited: Promise.resolve(0),
		stderr: new ReadableStream<Uint8Array>({
			start(controller) {
				if (stderrText) controller.enqueue(new TextEncoder().encode(stderrText));
				controller.close();
			},
		}),
	};
	return child;
}

describe("daemon startup", () => {
	test("retries the JSON-RPC connect on irregular gaps until signal-cli accepts", async () => {
		const waits: number[] = [];
		let connects = 0;
		const child = fakeChild();
		const started = await startSignalDaemon({
			binary: "signal-cli",
			dataDir: "/tmp/signal-data",
			spawn: () => child,
			rng: () => 0,
			uid: 1000,
			lstat: (path: string) =>
				({
					isSymbolicLink: () => false,
					isDirectory: () => !path.endsWith(".sock"),
					isSocket: () => path.endsWith(".sock"),
					mode: path.endsWith(".sock") ? 0o100755 : 0o40700,
					uid: 1000,
				}) as import("node:fs").Stats,
			sleep: async (ms) => {
				waits.push(ms);
			},
			connect: async () => {
				connects += 1;
				if (connects < 3) throw new Error("not listening");
				return { call: async () => undefined, drainNotifications: () => [], close: async () => undefined };
			},
		});
		expect(connects).toBe(3);
		expect(waits).toEqual([200, 337]);
		expect(child.killed).toBe(false);
		await started.stop();
		expect(child.killed).toBe(true);
	});

	test("gives up without logging a phone number from the daemon stderr", async () => {
		const child = fakeChild("bind failed for +15555550123\n");
		await expect(
			startSignalDaemon({
				binary: "signal-cli",
				dataDir: "/tmp/signal-data",
				socketPath: "/tmp/signal-data/daemon.sock",
				spawn: () => child,
				rng: () => 0,
				sleep: async () => undefined,
				lstat: () => {
					throw new Error("ENOENT");
				},
				connect: async () => {
					throw new Error("not listening");
				},
			}),
		).rejects.toThrow("[phone]");
		expect(child.killed).toBe(true);
	});
});

describe("daemon command", () => {
	test("starts signal-cli on a unix socket and never on localhost tcp", () => {
		const args = daemonArgs("/usr/bin/signal-cli", "/tmp/signal-data", "/tmp/signal-data/daemon.sock");
		expect(args).toContain("--socket=/tmp/signal-data/daemon.sock");
		expect(args.join(" ")).not.toContain("--tcp");
		expect(args.join(" ")).not.toContain("127.0.0.1");
	});

	test("starts multi-account daemon mode without a phone number on the command line", () => {
		const args = daemonArgs("/usr/bin/signal-cli", "/tmp/signal-data", "/tmp/signal-data/daemon.sock");
		expect(args).toEqual([
			"/usr/bin/signal-cli",
			"--data-dir",
			"/tmp/signal-data",
			"daemon",
			"--receive-mode=manual",
			"--socket=/tmp/signal-data/daemon.sock",
		]);
		expect(args.join(" ")).not.toContain("+");
		expect(args).not.toContain("-a");
		expect(args.join(" ")).not.toContain("--tcp");
	});

	test("refuses a group-accessible socket directory before connecting", async () => {
		let connected = false;
		const child = fakeChild();
		await expect(
			startSignalDaemon({
				binary: "signal-cli",
				dataDir: "/tmp/signal-data",
				socketPath: "/tmp/signal-data/daemon.sock",
				spawn: () => child,
				rng: () => 0,
				sleep: async () => undefined,
				uid: 1000,
				lstat: (path: string) =>
					({
						isSymbolicLink: () => false,
						isDirectory: () => !path.endsWith(".sock"),
						isSocket: () => path.endsWith(".sock"),
						mode: path.endsWith(".sock") ? 0o100755 : 0o40755,
						uid: 1000,
					}) as import("node:fs").Stats,
				connect: async () => {
					connected = true;
					throw new Error("connected");
				},
			}),
		).rejects.toThrow("group or world accessible");
		expect(connected).toBe(false);
		expect(child.killed).toBe(true);
	});

	test("accepts a real socket created under umask 022", async () => {
		const { chmodSync, lstatSync, mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const net = await import("node:net");
		const { assertSocketSafe } = await import("../src/signal/daemon");
		const previous = process.umask(0o022);
		const dir = mkdtempSync(join(tmpdir(), "ssms-sock-"));
		chmodSync(dir, 0o700);
		const sock = join(dir, "daemon.sock");
		const server = net.createServer();
		await new Promise<void>((resolve) => server.listen(sock, () => resolve()));
		try {
			const mode = lstatSync(sock).mode & 0o777;
			expect(mode & 0o077).not.toBe(0);
			expect(() => assertSocketSafe(sock, process.getuid?.() ?? -1)).not.toThrow();
		} finally {
			server.close();
			process.umask(previous);
		}
	});
});

describe("messageFromEnvelope", () => {
	test("reads text, images, quotes, and reactions without keeping the phone number", () => {
		const text = messageFromEnvelope({
			envelope: {
				sourceNumber: "+15555550123",
				sourceUuid: "u2",
				timestamp: 10,
				dataMessage: {
					timestamp: 10,
					message: "secret-body",
					attachments: [{ id: "a1", contentType: "image/jpeg", size: 12 }],
					quote: { id: 9, authorUuid: "u3", text: "earlier" },
				},
			},
		});
		expect(text).toEqual({
			id: "u2:10",
			conversationId: "u2",
			timestamp: 10,
			direction: "in",
			senderId: "u2",
			text: "secret-body",
			reaction: undefined,
			attachments: [{ id: "a1", contentType: "image/jpeg", byteLength: 12, path: undefined }],
			quote: { authorId: "u3", timestamp: 9, text: "earlier" },
		});
		expect(JSON.stringify(text)).not.toContain("+15555550123");
		const reaction = messageFromEnvelope({
			envelope: {
				sourceUuid: "u2",
				dataMessage: {
					timestamp: 11,
					reaction: {
						emoji: "👍",
						targetSentTimestamp: 10,
						targetAuthorUuid: "u3",
						isRemove: false,
					},
					groupInfo: { groupId: "g1" },
				},
			},
		});
		expect(reaction?.conversationId).toBe("g1");
		expect(reaction?.reaction).toEqual({
			emoji: "👍",
			targetTimestamp: 10,
			targetAuthorId: "u3",
			remove: false,
		});
	});
});
