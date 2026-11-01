import { chmodSync, rmSync } from "node:fs";
import net from "node:net";
import type { SessionRecord } from "./registry";

export type RunParams = {
	argv: string[];
	cwd: string;
	raw: boolean;
	snapshotDepth?: number;
};

export type DaemonRequest =
	| { id: string; method: "run" | "code"; params: RunParams }
	| { id: string; method: "stop" }
	| { id: string; method: "ping" };

export type DaemonResponse =
	| { id: string; result: { text: string; exitCode: number } }
	| { id: string; error: string };

const DEFAULT_TIMEOUT_MS = 120_000;

export function call(
	record: Pick<SessionRecord, "socketPath">,
	request: DaemonRequest,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DaemonResponse> {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ path: record.socketPath });
		let buffer = "";
		socket.setEncoding("utf8");
		socket.setTimeout(timeoutMs, () => {
			socket.destroy(
				new Error(
					`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the browser`,
				),
			);
		});
		socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			socket.removeAllListeners("close");
			socket.destroy();
			try {
				resolve(JSON.parse(buffer.slice(0, newline)) as DaemonResponse);
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", reject);
		socket.on("close", () =>
			reject(new Error("Daemon closed the connection before replying")),
		);
	});
}

export function serve(
	socketPath: string,
	onRequest: (request: DaemonRequest) => Promise<DaemonResponse>,
): Promise<net.Server> {
	const server = net.createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", () => socket.destroy());
		socket.on("data", async (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			const line = buffer.slice(0, newline);
			buffer = "";
			let response: DaemonResponse;
			try {
				response = await onRequest(JSON.parse(line) as DaemonRequest);
			} catch (error) {
				response = {
					id: "",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			socket.end(`${JSON.stringify(response)}\n`);
		});
	});
	rmSync(socketPath, { force: true });
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			chmodSync(socketPath, 0o600);
			resolve(server);
		});
	});
}
