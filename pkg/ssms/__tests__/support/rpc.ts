import net from "node:net";

export interface RpcCall {
	method: string;
	params: unknown;
}

export async function startFakeSignalServer(
	handler: (method: string, params: Record<string, unknown>, calls: RpcCall[]) => unknown,
) {
	const calls: RpcCall[] = [];
	const notes: string[] = [];
	const server = net.createServer((socket) => {
		let buf = "";
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				if (!line) continue;
				const message = JSON.parse(line) as { id?: string; method: string; params?: Record<string, unknown> };
				calls.push({ method: message.method, params: message.params ?? {} });
				const pending = notes.splice(0, notes.length).join("");
				try {
					const result = handler(message.method, message.params ?? {}, calls);
					socket.write(
						`${pending}${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`,
					);
				} catch (error) {
					socket.write(
						`${pending}${JSON.stringify({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32000, message: error instanceof Error ? error.message : "failed" },
						})}\n`,
					);
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		port,
		calls,
		push(method: string, params: unknown) {
			notes.push(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
		},
		close() {
			return new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
