import type { PairingRun, PairingSession } from "@dg/pages/chat-messages";

const PRESENCES: readonly string[] = ["cli", "gone", "idle"];

function parseRuns(value: unknown): PairingRun[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const run = (item ?? {}) as Partial<PairingRun>;
		return typeof run.sessionId === "string" &&
			typeof run.requestId === "string" &&
			typeof run.feature === "string" &&
			typeof run.startedAt === "number"
			? [
					{
						sessionId: run.sessionId,
						requestId: run.requestId,
						feature: run.feature,
						startedAt: run.startedAt,
					},
				]
			: [];
	});
}

export function parseSessions(reply: unknown): PairingSession[] {
	const list = (reply as { sessions?: unknown } | undefined)?.sessions;
	if (!Array.isArray(list)) return [];
	return list.flatMap((item) => {
		const fields = (item ?? {}) as Record<string, unknown>;
		if (
			typeof fields.sessionId !== "string" ||
			typeof fields.agentIdentity !== "string" ||
			typeof fields.connected !== "boolean"
		)
			return [];
		return [
			{
				sessionId: fields.sessionId,
				agentIdentity: fields.agentIdentity,
				connected: fields.connected,
				presence: PRESENCES.includes(fields.presence as string)
					? (fields.presence as PairingSession["presence"])
					: undefined,
				runs: parseRuns(fields.runs),
			},
		];
	});
}

export function agentLabel(sessions: readonly PairingSession[], sessionId: string): string {
	const shortId = sessionId.slice(0, 8);
	const identity = sessions.find((session) => session.sessionId === sessionId)?.agentIdentity;
	return identity === undefined ? shortId : `${identity} (${shortId})`;
}
