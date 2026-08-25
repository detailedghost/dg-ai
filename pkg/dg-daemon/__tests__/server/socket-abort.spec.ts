import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import type { ServerWebSocket } from "bun";
import {
	abortPendingWork,
	createSocketState,
	onSocketClose,
	type SocketState,
} from "../../src/server/connection";
import { createLogger } from "../../src/server/log";
import { freshDgHome } from "../utils/daemon-harness";

function fakeSocket(): ServerWebSocket<SocketState> {
	const paths = resolveDgPaths({ env: { DG_HOME: freshDgHome() } });
	return {
		data: createSocketState("cli", createLogger(paths)),
	} as ServerWebSocket<SocketState>;
}

describe("work abandoned when a socket goes away", () => {
	it("runs every registered cancel and clears them, so a second close is a no-op", () => {
		const ws = fakeSocket();
		const ran: string[] = [];
		onSocketClose(ws, () => ran.push("first"));
		onSocketClose(ws, () => ran.push("second"));

		abortPendingWork(ws);
		abortPendingWork(ws);

		expect(ran).toEqual(["first", "second"]);
		expect(ws.data.closeWaiters.size).toBe(0);
	});

	it("does not run a cancel the settled path already de-registered", () => {
		const ws = fakeSocket();
		const ran: string[] = [];
		const deregister = onSocketClose(ws, () => ran.push("stale"));
		onSocketClose(ws, () => ran.push("live"));

		deregister();
		abortPendingWork(ws);

		expect(ran).toEqual(["live"]);
	});

	it("is called from the websocket close handler, so a parked recv stops when its client leaves", () => {
		const http = readFileSync(
			join(import.meta.dir, "../../src/server/http.ts"),
			"utf8",
		);
		const closeHandler = /close\(ws\) \{([\s\S]*?)\n\t\t\t\},/.exec(http)?.[1];

		expect(closeHandler).toBeDefined();
		expect(closeHandler).toContain("abortPendingWork(ws)");
	});

	it("hands a rejected frame handler to a catch, so one bad frame cannot kill the process", () => {
		const http = readFileSync(
			join(import.meta.dir, "../../src/server/http.ts"),
			"utf8",
		);
		const messageHandler =
			/message\(ws, message\) \{([\s\S]*?)\n\t\t\t\},/.exec(http)?.[1];

		expect(messageHandler).toBeDefined();
		expect(messageHandler).toContain(".catch(");
		expect(messageHandler).not.toContain("void handleSocketMessage");
	});

	it("is registered by a blocking cli-recv, which is the work that needs abandoning", () => {
		const handlers = readFileSync(
			join(import.meta.dir, "../../src/server/frame-handlers.ts"),
			"utf8",
		);

		expect(handlers).toContain("onSocketClose(");
	});
});
