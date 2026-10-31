import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { nextGapMs, type Rng } from "../pace/jitter";
import { redactSecrets } from "../privacy/redact";
import { connectJsonRpcPath, type RpcTransport } from "./rpc";

export interface Spawned {
	kill: (signal?: NodeJS.Signals) => void;
	exited: Promise<number>;
	stderr: ReadableStream<Uint8Array>;
}

export interface SocketStat {
	isSocket: () => boolean;
	mode: number;
	uid: number;
}

export function daemonArgs(binary: string, dataDir: string, socketPath: string): string[] {
	return [
		binary,
		"--data-dir",
		dataDir,
		"daemon",
		"--receive-mode=manual",
		`--socket=${socketPath}`,
	];
}

export function prepareSocketDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

export function assertSocketSafe(socketPath: string, uid: number, read: (path: string) => import("node:fs").Stats = lstatSync): void {
	const dir = dirname(socketPath);
	const directory = read(dir);
	if (directory.isSymbolicLink()) throw new Error("signal-cli socket directory is a symlink");
	if (!directory.isDirectory()) throw new Error("signal-cli socket directory is not a directory");
	if ((directory.mode & 0o077) !== 0) {
		throw new Error("signal-cli socket directory is group or world accessible");
	}
	if (directory.uid !== uid) throw new Error("signal-cli socket directory is owned by another user");
	const socket = read(socketPath);
	if (socket.isSymbolicLink()) throw new Error("signal-cli socket is a symlink");
	if (!socket.isSocket()) throw new Error("signal-cli endpoint is not a unix socket");
	if (socket.uid !== uid) throw new Error("signal-cli socket is owned by another user");
}

function socketUnsafe(error: unknown): boolean {
	const message = error instanceof Error ? error.message : "";
	return /symlink|not a directory|group or world accessible|owned by another user|not a unix socket/.test(
		message,
	);
}

async function readStderr(stream: ReadableStream<Uint8Array>, limit = 500): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const started = Date.now();
	while (text.length < limit && Date.now() - started < 20) {
		const next = await Promise.race([
			reader.read(),
			new Promise<{ done: true; value?: Uint8Array }>((resolve) =>
				setTimeout(() => resolve({ done: true }), 5),
			),
		]);
		if (next.done) break;
		if (next.value) text += decoder.decode(next.value, { stream: true });
	}
	reader.releaseLock();
	return redactSecrets(text).slice(0, limit);
}

export async function startSignalDaemon(input: {
	binary: string;
	dataDir: string;
	socketPath?: string;
	spawn: (cmd: string[]) => Spawned;
	connect?: (socketPath: string) => Promise<RpcTransport>;
	lstat?: (path: string) => import("node:fs").Stats;
	uid?: number;
	sleep?: (ms: number) => Promise<void>;
	rng?: Rng;
}): Promise<{ transport: RpcTransport; socketPath: string; stop: () => Promise<void> }> {
	const socketPath = input.socketPath ?? join(input.dataDir, "daemon.sock");
	prepareSocketDir(dirname(socketPath));
	const cmd = daemonArgs(input.binary, input.dataDir, socketPath);
	const child = input.spawn(cmd);
	const connect = input.connect ?? ((path: string) => connectJsonRpcPath(path));
	const read = input.lstat ?? lstatSync;
	const uid = input.uid ?? process.getuid?.() ?? -1;
	const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
	const rng = input.rng ?? Math.random;
	const gaps: number[] = [];
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			assertSocketSafe(socketPath, uid, read);
			const transport = await connect(socketPath);
			return {
				transport,
				socketPath,
				stop: async () => {
					await transport.close();
					child.kill();
					await Promise.race([
						child.exited.catch(() => 0),
						new Promise((resolve) => setTimeout(resolve, 200)),
					]);
				},
			};
		} catch (error) {
			if (socketUnsafe(error)) {
				child.kill();
				throw error;
			}
			lastError = error;
			const gap = nextGapMs(rng, gaps);
			gaps.push(gap);
			await sleep(gap);
		}
	}
	child.kill();
	const detail = await readStderr(child.stderr).catch(() => "");
	const message = lastError instanceof Error ? lastError.message : "signal-cli daemon failed";
	throw new Error(redactSecrets(detail ? `${message}: ${detail}` : message));
}
