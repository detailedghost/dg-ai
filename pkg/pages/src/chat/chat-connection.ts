import { redactText, type SessionPresence } from "@dg/common";

export type PublicSession = {
	sessionId: string;
	agentIdentity: string;
	presence?: SessionPresence;
};

export type HeldSession = {
	sessionId: string;
	connected: boolean;
};

export type SessionControl = {
	sessionId: string;
	agentIdentity: string;
	presence: SessionPresence;
	held: boolean;
	connected: boolean;
	canConnect: boolean;
	canStop: boolean;
	canDisconnect: boolean;
	stale: boolean;
};

export function sessionControls(
	catalog: PublicSession[],
	held: HeldSession[],
): SessionControl[] {
	const heldById = new Map(held.map((session) => [session.sessionId, session]));
	const seen = new Set<string>();
	const controls: SessionControl[] = [];
	for (const session of catalog) {
		if (seen.has(session.sessionId)) continue;
		seen.add(session.sessionId);
		controls.push(controlFor(session, heldById.get(session.sessionId)));
	}
	for (const session of held) {
		if (seen.has(session.sessionId)) continue;
		seen.add(session.sessionId);
		controls.push(
			controlFor(
				{
					sessionId: session.sessionId,
					agentIdentity: "session",
					presence: session.connected ? "cli" : "idle",
				},
				session,
			),
		);
	}
	return controls;
}

function controlFor(
	session: PublicSession,
	held: HeldSession | undefined,
): SessionControl {
	const presence = session.presence ?? "idle";
	const connected = held?.connected === true;
	const isHeld = held !== undefined;
	return {
		sessionId: session.sessionId,
		agentIdentity: session.agentIdentity,
		presence,
		held: isHeld,
		connected,
		canConnect: !isHeld,
		canStop: isHeld,
		canDisconnect: isHeld && connected,
		stale: presence === "gone" || presence === "idle",
	};
}

export function staleSessionIds(controls: SessionControl[]): string[] {
	return controls.filter((control) => control.stale).map((control) => control.sessionId);
}

/** What the side panel should tell the human to do next. Exact strings are part of the panel contract. */
export function connectionGuidance(input: {
	daemonUp: boolean;
	paired: boolean;
	presences: readonly SessionPresence[];
	heldDisconnected?: boolean;
}): string {
	if (!input.daemonUp) return "Start the daemon: run dg-agent start";
	if (input.presences.includes("waiting")) {
		return "A session is waiting for the CLI. Run dg-agent attach in the terminal.";
	}
	if (input.presences.includes("cli") && !input.paired) {
		return "The CLI is connected. Choose Connect on that session.";
	}
	if (input.paired) return "Paired — connection confirmed";
	if (input.heldDisconnected) {
		return "Disconnected — waiting for the daemon to confirm the connection.";
	}
	if (input.presences.length === 0) {
		return "No session yet. Choose New session for CLI, then run dg-agent attach.";
	}
	return "Choose Connect on a session, or run dg-agent start.";
}

/** Strips known session tokens, and every other credential the shared redactor knows. */
export function redactSecrets(message: string, secrets: readonly string[]): string {
	return redactText(message, secrets);
}

export type HandshakeOutcome = "ok" | "drop" | "retry";

export function handshakeOutcome(frame: {
	type: string;
	code?: string;
	message?: string;
}): HandshakeOutcome {
	if (frame.type === "session-list") return "ok";
	if (frame.type !== "error") return "retry";
	if (frame.code === "invalid-session") return "drop";
	if (/protocol version mismatch/i.test(frame.message ?? "")) return "drop";
	return "retry";
}

export function reconnectDelayMs(
	attempt: number,
	baseMs: number,
	maxMs: number,
	jitter: number,
): number {
	const raw = Math.min(baseMs * 2 ** attempt, maxMs);
	return Math.min(raw * (1 + jitter), maxMs);
}
