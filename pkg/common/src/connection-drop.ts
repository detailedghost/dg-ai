import { redactText } from "./redact";

export type ConnectionPhase =
	| "extension-load"
	| "daemon-discover"
	| "handshake"
	| "connected"
	| "reconnecting"
	| "dropped";

export type DropMessage = {
	direction: "in" | "out";
	type: string;
	at: string;
	summary?: string;
};

export type ConnectionDropInput = {
	at?: string;
	phase: ConnectionPhase;
	reason: string;
	sessionIds?: readonly string[];
	port?: number;
	socket?: { readyState?: string; url?: string };
	sidePanel?: { open?: boolean; url?: string; lifecycle?: string };
	serviceWorker?: { lifecycle?: string; active?: boolean };
	lastMessages?: readonly DropMessage[];
	timers?: {
		keepaliveMs?: number;
		reconnectAttempt?: number;
		nextDelayMs?: number;
		heartbeat?: string;
	};
	daemon?: { reachable?: boolean; port?: number; instanceId?: string };
	agent?: { attached?: boolean; presence?: string };
	secrets?: readonly string[];
};

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function redactSessionId(sessionId: string): string {
	if (!UUID.test(sessionId)) return sessionId;
	return `${sessionId.slice(0, 8)}[redacted]`;
}

/** One JSON line. Tokens, URLs, and full session ids are already redacted. */
export function formatConnectionDrop(input: ConnectionDropInput): string {
	const report = {
		at: input.at ?? new Date().toISOString(),
		phase: input.phase,
		reason: input.reason,
		sessionIds: (input.sessionIds ?? []).map(redactSessionId),
		port: input.port ?? null,
		socket: input.socket ?? null,
		sidePanel: input.sidePanel ?? null,
		serviceWorker: input.serviceWorker ?? null,
		lastMessages: (input.lastMessages ?? []).map((message) => ({
			direction: message.direction,
			type: message.type,
			at: message.at,
			...(message.summary ? { summary: message.summary.slice(0, 180) } : {}),
		})),
		timers: input.timers ?? null,
		daemon: input.daemon ?? null,
		agent: input.agent ?? null,
	};
	return redactText(JSON.stringify(report), input.secrets);
}

export function logHarnessLine(
	message: string,
	write: (line: string) => void = (line) => console.error(line),
	secrets?: readonly string[],
): void {
	write(redactText(message, secrets));
}

export function logConnectionDrop(
	input: ConnectionDropInput,
	write: (line: string) => void = (line) => console.error(line),
): void {
	write(formatConnectionDrop(input));
}
