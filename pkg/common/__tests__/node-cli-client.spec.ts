import { afterEach, describe, expect, it } from "bun:test";
import { CliClient } from "../src/node";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
	server?.stop(true);
	server = undefined;
});

function serve() {
	const sockets: Array<{ close(): void }> = [];
	server = Bun.serve({
		port: 0,
		fetch(request, bunServer) {
			return bunServer.upgrade(request, { data: undefined }) ? undefined : new Response("no", { status: 400 });
		},
		websocket: {
			open(socket) {
				sockets.push(socket);
			},
			message() {},
		},
	});
	return { port: server.port as number, sockets };
}

describe("CliClient.onClose", () => {
	it("runs the handler when the daemon closes the socket", async () => {
		const { port, sockets } = serve();
		const client = await CliClient.connect({ port, sessionId: "s", token: "t" }, 2_000, {});
		const closed = new Promise<void>((resolve) => client.onClose(resolve));
		sockets[0]?.close();
		await closed;
	});

	it("runs the handler when the client closes the socket", async () => {
		const { port } = serve();
		const client = await CliClient.connect({ port, sessionId: "s", token: "t" }, 2_000, {});
		const closed = new Promise<void>((resolve) => client.onClose(resolve));
		client.close();
		await closed;
	});
});
