import { lstatSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { isAbsolute, join } from "node:path";
import { DgCliError } from "../../errors";
import { FRAME_FLAG_ERROR, FRAME_FLAG_RESPONSE, PROTOCOL_VERSION, ROUTE_TIMEOUT_MS, validateMessage, type DecodedFrame, type Route } from "../contract";
import { encodeFrame, FrameReader } from "./framing";

const HELLO_REQUEST = { protocol: PROTOCOL_VERSION, encodings: ["json"], capabilities: [] as string[] };
const MAX_REQUEST_ID = 0xffff_ffff;

type Pending = { route: Route; resolve: (body: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function ipcError(path: string, detail: string, next: string): DgCliError {
	return new DgCliError(`dg plugin: ipc ${path}: ${detail}. Next: ${next}`);
}

export function windowsPipePath(plugin: string): string {
	return `\\\\.\\pipe\\dg-plugin-${plugin}`;
}

function isBareFileName(endpoint: string): boolean {
	return endpoint !== "" && endpoint !== "." && endpoint !== ".." && !/[/\\\0]/.test(endpoint) && !isAbsolute(endpoint);
}

export function ipcEndpoint(plugin: string, pluginDir: string, endpoint: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") return windowsPipePath(plugin);
	if (!isBareFileName(endpoint))
		throw new DgCliError(`dg plugin: ${plugin}: the ipc endpoint must be a plain file name inside the plugin folder. Next: fix endpoint in plugin.toml.`);
	return join(pluginDir, endpoint);
}

export function assertSocketPrivate(path: string): void {
	if (process.platform === "win32") return;
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		throw ipcError(path, "socket file not found", "start the plugin, then retry");
	}
	if (!stat.isSocket()) throw ipcError(path, "not a unix socket", "point the plugin endpoint at the plugin's socket file");
	const mode = stat.mode & 0o777;
	if ((mode & 0o177) !== 0)
		throw ipcError(path, `permissions are 0${mode.toString(8)}, the limit is 0600`, `run chmod 600 ${path} or fix the plugin's umask`);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) throw ipcError(path, `socket is owned by uid ${stat.uid}, not uid ${uid}`, "run only plugins you own");
}

export class IpcConnection {
	private readonly reader = new FrameReader();
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private closedBy: Error | undefined;
	private readonly closeListeners: Array<() => void> = [];

	constructor(
		private readonly socket: Socket,
		private readonly path: string,
	) {
		socket.setNoDelay?.(true);
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", (error) => this.fail(ipcError(path, `socket error: ${error.message}`, "restart the plugin")));
		socket.on("close", () => this.fail(ipcError(path, "connection closed", "restart the plugin")));
	}

	get closed(): boolean {
		return this.closedBy !== undefined;
	}

	onClose(listener: () => void): void {
		this.closeListeners.push(listener);
	}

	async request(route: Route, body: unknown, timeoutMs: number = ROUTE_TIMEOUT_MS[route]): Promise<unknown> {
		if (this.closedBy) throw this.closedBy;
		validateMessage(route, "request", body);
		const requestId = this.takeId();
		const payload = new TextEncoder().encode(JSON.stringify({ route, body }));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(requestId);
				reject(ipcError(this.path, `${route} timed out after ${timeoutMs} ms`, "check that the plugin is responsive"));
			}, timeoutMs);
			this.pending.set(requestId, { route, resolve, reject, timer });
			this.socket.write(encodeFrame({ encoding: "json", flags: 0, requestId, payload }));
		});
	}

	close(): void {
		this.fail(ipcError(this.path, "connection closed", "open a new connection"));
		this.socket.destroy();
	}

	private takeId(): number {
		const id = this.nextId;
		this.nextId = id === MAX_REQUEST_ID ? 1 : id + 1;
		return id;
	}

	private onData(chunk: Uint8Array): void {
		let frames: DecodedFrame[];
		try {
			frames = this.reader.push(chunk);
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
			this.socket.destroy();
			return;
		}
		for (const frame of frames) this.onFrame(frame);
	}

	private onFrame(frame: DecodedFrame): void {
		if ((frame.flags & FRAME_FLAG_RESPONSE) === 0) return;
		const entry = this.pending.get(frame.requestId);
		if (!entry) return;
		this.pending.delete(frame.requestId);
		clearTimeout(entry.timer);
		try {
			const body: unknown = JSON.parse(new TextDecoder().decode(frame.payload));
			if ((frame.flags & FRAME_FLAG_ERROR) !== 0) {
				const { code, message } = body as { code?: string; message?: string };
				throw ipcError(this.path, `${entry.route} failed: ${code}: ${message}`, "fix the request, see docs/plugin-protocol.md");
			}
			validateMessage(entry.route, "response", body);
			entry.resolve(body);
		} catch (error) {
			entry.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private fail(error: Error): void {
		if (this.closedBy) return;
		this.closedBy = error;
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
		for (const listener of this.closeListeners) listener();
	}
}

function openSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect({ path });
		socket.once("connect", () => resolve(socket));
		socket.once("error", (error) => reject(ipcError(path, `cannot connect: ${error.message}`, "start the plugin, then retry")));
	});
}

export async function connectIpc(path: string): Promise<IpcConnection> {
	assertSocketPrivate(path);
	const socket = await openSocket(path);
	const connection = new IpcConnection(socket, path);
	try {
		await connection.request("/v1/hello", HELLO_REQUEST);
	} catch (error) {
		connection.close();
		throw error;
	}
	return connection;
}

const warm = new Map<string, Promise<IpcConnection>>();

export function getIpcConnection(plugin: string, path: string): Promise<IpcConnection> {
	const existing = warm.get(plugin);
	if (!existing) return open(plugin, path);
	return existing.then(
		(connection) => (connection.closed ? reopen(plugin, path, existing) : connection),
		() => reopen(plugin, path, existing),
	);
}

function reopen(plugin: string, path: string, stale: Promise<IpcConnection>): Promise<IpcConnection> {
	const current = warm.get(plugin);
	return current !== undefined && current !== stale ? current : open(plugin, path);
}

function open(plugin: string, path: string): Promise<IpcConnection> {
	const attempt = connectIpc(path).then((connection) => {
		connection.onClose(() => {
			if (warm.get(plugin) === attempt) warm.delete(plugin);
		});
		return connection;
	});
	warm.set(plugin, attempt);
	attempt.catch(() => {
		if (warm.get(plugin) === attempt) warm.delete(plugin);
	});
	return attempt;
}

export function closeIpcConnections(): void {
	for (const attempt of warm.values()) attempt.then((connection) => connection.close(), () => {});
	warm.clear();
}
