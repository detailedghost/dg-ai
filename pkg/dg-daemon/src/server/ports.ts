import { CHAT_DEFAULT_PORT, CHAT_PORT_FALLBACK_COUNT } from "@dg/common";

const MAX_TCP_PORT = 65_535;

function isUsablePort(value: number): boolean {
	return Number.isInteger(value) && value > 0 && value <= MAX_TCP_PORT;
}

export function candidatePorts(): number[] {
	const pinned = process.env.DG_PORT;
	if (pinned === undefined) {
		return Array.from(
			{ length: CHAT_PORT_FALLBACK_COUNT + 1 },
			(_, i) => CHAT_DEFAULT_PORT + i,
		);
	}
	const port = Number(pinned);
	if (!isUsablePort(port)) {
		throw new Error(
			`DG_PORT must be an integer from 1 to ${MAX_TCP_PORT}, got "${pinned}"`,
		);
	}
	return [port];
}
