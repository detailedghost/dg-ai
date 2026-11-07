import {
	createSerialQueue,
	describeError,
	type SessionAdopt,
} from "@dg/common";
import type { ServerWebSocket } from "bun";
import type { SessionRecord } from "../session/registry";
import type { Logger } from "./log";

export type SocketKind = "ws" | "cli";

export type SocketState = {
	kind: SocketKind;
	capabilities: Map<string, string>;
	invalidFrameCount: number;
	enqueue: (task: () => Promise<void>) => Promise<void>;
	drainWaiters: Array<() => void>;
	closeWaiters: Set<() => void>;
	originHeader?: string;
	extensionVersion?: string;
	localPage: boolean;
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
			logger.error(`outbound send failed: ${describeError(err)}`);
		}),
		drainWaiters: [],
		closeWaiters: new Set(),
		originHeader,
		localPage: false,
	};
}

export type DaemonLink = { port: number; daemonId: string };

export type AdoptableSession = Pick<
	SessionRecord,
	"sessionId" | "token" | "agentIdentity"
>;

export function sessionAdoptPayload(
	record: AdoptableSession,
	link: DaemonLink,
): string {
	return JSON.stringify({
		type: "session-adopt",
		bootstrap: {
			port: link.port,
			sessionId: record.sessionId,
			token: record.token,
			agentIdentity: record.agentIdentity,
			daemonId: link.daemonId,
		},
	} satisfies SessionAdopt);
}

/** A chat socket from the extension, the only peer that can serve browser relays and overwatch opens. */
export function isExtensionPeer(ws: ServerWebSocket<SocketState>): boolean {
	return ws.data.kind === "ws" && !ws.data.localPage;
}

/** Registers work to abandon when the socket goes away; returns the de-registration for the settled path. */
export function onSocketClose(
	ws: ServerWebSocket<SocketState>,
	cancel: () => void,
): () => void {
	ws.data.closeWaiters.add(cancel);
	return () => ws.data.closeWaiters.delete(cancel);
}

export function abortPendingWork(ws: ServerWebSocket<SocketState>): void {
	const waiters = [...ws.data.closeWaiters];
	ws.data.closeWaiters.clear();
	for (const cancel of waiters) cancel();
}

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

	extensionVersion(): string | null {
		let latest: string | null = null;
		for (const ws of this.sockets) {
			if (isExtensionPeer(ws) && ws.data.extensionVersion) {
				latest = ws.data.extensionVersion;
			}
		}
		return latest;
	}

	broadcastToPages(frame: Record<string, unknown>): void {
		const payload = JSON.stringify(frame);
		for (const ws of this.sockets) {
			if (ws.data.kind !== "ws") continue;
			if (ws.data.capabilities.size === 0) continue;
			void sendViaQueue(ws, payload);
		}
	}

	forEachExtension(fn: (ws: ServerWebSocket<SocketState>) => void): number {
		let count = 0;
		for (const ws of this.sockets) {
			if (!isExtensionPeer(ws)) continue;
			count++;
			fn(ws);
		}
		return count;
	}

	pushSessionAdopt(record: AdoptableSession, link: DaemonLink): number {
		const payload = sessionAdoptPayload(record, link);
		return this.forEachExtension((ws) => void sendViaQueue(ws, payload));
	}

	forEachCapableOf(
		sessionId: string,
		fn: (ws: ServerWebSocket<SocketState>) => void,
	): void {
		for (const ws of this.sockets) {
			if (ws.data.capabilities.has(sessionId)) fn(ws);
		}
	}
}
