import {
	CHAT_DEFAULT_PORT,
	CHAT_HEALTH_PATH,
	CHAT_PORT_FALLBACK_COUNT,
} from "@dg/common";

const DAEMON_HEALTH_NAMES = ["dg-daemon", "dg-server"] as const;

const HEALTH_PROBE_TIMEOUT_MS = 2_000;

export type DaemonName = (typeof DAEMON_HEALTH_NAMES)[number];
export type ChatHealth = { daemon: DaemonName; instanceId: string };

function asDaemonName(value: unknown): DaemonName | undefined {
	return DAEMON_HEALTH_NAMES.find((name) => name === value);
}

export async function fetchDaemonHealth(
	port: number,
): Promise<ChatHealth | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}${CHAT_HEALTH_PATH}`, {
			signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as {
			daemon?: unknown;
			instanceId?: unknown;
		};
		const daemon = asDaemonName(body.daemon);
		if (!daemon || typeof body.instanceId !== "string") return undefined;
		return { daemon, instanceId: body.instanceId };
	} catch {
		return undefined;
	}
}

/** Probe the port range the daemon binds, preferring the instance we last talked to. */
export async function findDaemonPort(
	preferInstanceId?: string,
	probe: (port: number) => Promise<ChatHealth | undefined> = fetchDaemonHealth,
): Promise<number | undefined> {
	const candidates = Array.from(
		{ length: CHAT_PORT_FALLBACK_COUNT + 1 },
		(_, index) => CHAT_DEFAULT_PORT + index,
	);
	const healths = await Promise.all(candidates.map(probe));
	if (preferInstanceId !== undefined) {
		const preferred = candidates.find(
			(_, index) => healths[index]?.instanceId === preferInstanceId,
		);
		if (preferred !== undefined) return preferred;
	}
	const fallbackIndex = healths.findIndex((health) => health !== undefined);
	return fallbackIndex === -1 ? undefined : candidates[fallbackIndex];
}
