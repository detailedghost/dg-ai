import net from "node:net";
import { nextGapMs, type Rng } from "../pace/jitter";
import { redactSecrets } from "../privacy/redact";
import { connectJsonRpc, type RpcTransport } from "./rpc";

export interface Spawned {
	kill: (signal?: NodeJS.Signals) => void;
	exited: Promise<number>;
	stderr: ReadableStream<Uint8Array>;
}

export function daemonArgs(binary: string, dataDir: string, port: number): string[] {
	return [binary, "--data-dir", dataDir, "daemon", `--tcp=127.0.0.1:${port}`];
}

export async function freeTcpPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (port === 0) throw new Error("could not reserve a local port for signal-cli");
	return port;
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
	spawn: (cmd: string[]) => Spawned;
	connect?: (port: number) => Promise<RpcTransport>;
	freePort?: () => Promise<number>;
	sleep?: (ms: number) => Promise<void>;
	rng?: Rng;
}): Promise<{ transport: RpcTransport; port: number; stop: () => Promise<void> }> {
	const port = await (input.freePort ?? freeTcpPort)();
	const cmd = daemonArgs(input.binary, input.dataDir, port);
	const child = input.spawn(cmd);
	const connect = input.connect ?? ((chosen: number) => connectJsonRpc(chosen));
	const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms));
	const rng = input.rng ?? Math.random;
	const gaps: number[] = [];
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			const transport = await connect(port);
			return {
				transport,
				port,
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
