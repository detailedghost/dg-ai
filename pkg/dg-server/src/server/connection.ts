import { createSerialQueue } from "@dg/common";
import type { ServerWebSocket } from "bun";
import type { Logger } from "./log";

export type SocketKind = "ws" | "cli";

/** Per-connection state. Capabilities accumulate sessionId -> token pairs only via
 * a captured bootstrap (header at /cli upgrade, "connect" handshake on /ws) or an
 * authenticated session-create response — never from an inbound frame's own claim. */
export type SocketState = {
	kind: SocketKind;
	capabilities: Map<string, string>;
	invalidFrameCount: number;
	enqueue: (task: () => Promise<void>) => Promise<void>;
	drainWaiters: Array<() => void>;
	/** /ws only — the upgrade's Origin header, kept for the TOFU pin commit on first proven capability. */
	originHeader?: string;
};

export function createSocketState(
	kind: SocketKind,
	logger: Logger,
	originHeader?: string,
): SocketState {
	return {
		kind,
		capabilities: new Map(),
		invalidFrameCount: 0,
		enqueue: createSerialQueue((err) => {
			logger.error(
				`outbound send failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}),
		drainWaiters: [],
		originHeader,
	};
}

/**
 * One createSerialQueue per socket (never daemon-wide, which would head-of-line
 * block every session behind one slow socket), awaiting ServerWebSocket drain
 * on backpressure.
 */
export function sendViaQueue(
	ws: ServerWebSocket<SocketState>,
	payload: string,
): Promise<void> {
	return ws.data.enqueue(async () => {
		const result = ws.send(payload);
		if (result === -1) {
			await new Promise<void>((resolve) => {
				ws.data.drainWaiters.push(resolve);
			});
		}
	});
}

export function resolveDrainWaiters(ws: ServerWebSocket<SocketState>): void {
	const waiters = ws.data.drainWaiters.splice(0);
	for (const resolve of waiters) resolve();
}

const INVALID_FRAME_BUDGET = 10;

/** Returns true once the budget is exceeded — caller closes the connection. */
export function registerInvalidFrame(state: SocketState): boolean {
	state.invalidFrameCount++;
	return state.invalidFrameCount > INVALID_FRAME_BUDGET;
}

export class ConnectionManager {
	private readonly sockets = new Set<ServerWebSocket<SocketState>>();

	add(ws: ServerWebSocket<SocketState>): void {
		this.sockets.add(ws);
	}

	remove(ws: ServerWebSocket<SocketState>): void {
		this.sockets.delete(ws);
	}

	openCount(): number {
		return this.sockets.size;
	}

	/** session-list to every /ws socket that has proven at least one capability — an Origin alone authenticates nothing, so an unauthenticated socket gets nothing. */
	broadcastToPages(frame: Record<string, unknown>): void {
		const payload = JSON.stringify(frame);
		for (const ws of this.sockets) {
			if (ws.data.kind !== "ws") continue;
			if (ws.data.capabilities.size === 0) continue;
			void sendViaQueue(ws, payload);
		}
	}

	/** Every open socket (page or CLI) that holds a capability for sessionId — used to invalidate/notify on close. */
	forEachCapableOf(
		sessionId: string,
		fn: (ws: ServerWebSocket<SocketState>) => void,
	): void {
		for (const ws of this.sockets) {
			if (ws.data.capabilities.has(sessionId)) fn(ws);
		}
	}
}
