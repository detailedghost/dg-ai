import net from "node:net";
import { redactSecrets } from "../privacy/redact";

export interface RpcNotification {
	method: string;
	params: unknown;
}

export interface RpcTransport {
	call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>;
	drainNotifications(): RpcNotification[];
	close(): Promise<void>;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export function connectJsonRpc(port: number, host = "127.0.0.1"): Promise<RpcTransport> {
	return attachRpc(net.connect({ port, host }));
}

export function connectJsonRpcPath(socketPath: string): Promise<RpcTransport> {
	return attachRpc(net.connect({ path: socketPath }));
}

function attachRpc(socket: net.Socket): Promise<RpcTransport> {
	return new Promise((resolve, reject) => {
		const pending = new Map<string, Pending>();
		const notes: RpcNotification[] = [];
		let buf = "";
		let settled = false;
		const fail = (error: Error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
			for (const [id, item] of pending) {
				clearTimeout(item.timer);
				pending.delete(id);
				item.reject(error);
			}
		};
		socket.on("error", (error) => fail(error));
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				if (!line) continue;
				let message: Record<string, unknown>;
				try {
					message = JSON.parse(line) as Record<string, unknown>;
				} catch {
					fail(new Error("signal-cli returned a line that is not JSON"));
					return;
				}
				const id = message.id === undefined || message.id === null ? undefined : String(message.id);
				if (!id) {
					if (typeof message.method === "string") {
						notes.push({ method: message.method, params: message.params });
					}
					continue;
				}
				const waiter = pending.get(id);
				if (!waiter) continue;
				clearTimeout(waiter.timer);
				pending.delete(id);
				if (message.error !== undefined) {
					const err = message.error as { message?: unknown };
					const detail = typeof err?.message === "string" ? err.message : "signal-cli request failed";
					waiter.reject(new Error(redactSecrets(detail)));
				} else waiter.resolve(message.result);
			}
		});
		socket.once("connect", () => {
			settled = true;
			resolve({
				call(method, params, timeoutMs) {
					const id = crypto.randomUUID();
					const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
					return new Promise((resolveCall, rejectCall) => {
						const timer = setTimeout(() => {
							pending.delete(id);
							rejectCall(new Error(`signal-cli ${method} timed out`));
						}, timeoutMs);
						pending.set(id, { resolve: resolveCall, reject: rejectCall, timer });
						socket.write(`${payload}\n`);
					});
				},
				drainNotifications() {
					return notes.splice(0, notes.length);
				},
				close() {
					socket.end();
					return new Promise((done) => {
						socket.once("close", () => done());
						setTimeout(() => {
							socket.destroy();
							done();
						}, 50);
					});
				},
			});
		});
	});
}
