import { CHAT_DEFAULT_PORT, CHAT_PORT_FALLBACK_COUNT } from "@dg/common";

/**
 * DG_PORT pins a single port (the test seam and any explicit override); with
 * it unset, the candidates are the fixed default plus its deterministic
 * fallback range, tried in order by the daemonize loop in bootstrap.ts.
 */
export function candidatePorts(): number[] {
	const pinned = process.env.DG_PORT;
	if (pinned !== undefined) {
		const port = Number(pinned);
		if (!Number.isFinite(port)) {
			throw new Error(`DG_PORT must be a number, got "${pinned}"`);
		}
		return [port];
	}
	return Array.from(
		{ length: CHAT_PORT_FALLBACK_COUNT + 1 },
		(_, i) => CHAT_DEFAULT_PORT + i,
	);
}
