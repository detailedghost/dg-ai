import { isWSL as detectIsWSL, runCapture } from "@dg/common/node";
import { DgCliError, EXIT_WSL_NAT_NETWORKING } from "./errors";

export type WslNetworkingMode = "mirrored" | "nat" | "unknown";

export type WslGuardSeams = {
	isWSL?: () => boolean;
	/** DG_WSL_NETWORKING_MODE-style injection point — ambient .wslconfig state
	 * on the Windows side cannot be driven from a test, so this mirrors the
	 * DG_-prefixed seam convention (DG_HOME, DG_PORT, DG_IDLE_TTL_MS). */
	networkingMode?: () => Promise<WslNetworkingMode>;
	env?: Record<string, string | undefined>;
};

const REMEDIATION =
	"loopback is only reachable from a Windows-side browser when WSL uses mirrored networking. " +
	"Set networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig on the Windows side, then run `wsl --shutdown` and restart.";

/** Best-effort: read the Windows-side .wslconfig for networkingMode. Never throws. */
async function detectNetworkingMode(): Promise<WslNetworkingMode> {
	try {
		const profile = await runCapture("cmd.exe", [
			"/c",
			"echo",
			"%USERPROFILE%",
		]);
		if (profile.status !== 0) return "unknown"; // probe itself could not run
		const winPath = `${profile.stdout.replace(/\r?\n$/, "")}\\.wslconfig`;
		const linuxPath = await runCapture("wslpath", ["-u", winPath]);
		if (linuxPath.status !== 0) return "unknown"; // probe itself could not run
		const contents = await runCapture("cat", [linuxPath.stdout.trim()]);
		// .wslconfig is opt-in; an absent file or a missing key is WSL2's
		// documented real default (NAT), not an unreadable-probe "unknown".
		if (contents.status !== 0) return "nat";
		const match = contents.stdout.match(/networkingMode\s*=\s*(\w+)/i);
		if (!match) return "nat";
		return match[1].toLowerCase() === "mirrored" ? "mirrored" : "nat";
	} catch {
		return "unknown";
	}
}

/**
 * Refuse to start on WSL in NAT networking mode ("unknown" is permissive —
 * a probe failure must not block startup on unreadable ambient state).
 * Returns the resolved mode ("n/a" off WSL) so status can reuse the probe.
 */
export async function checkWslNetworking(
	seams: WslGuardSeams = {},
): Promise<WslNetworkingMode | "n/a"> {
	const env = seams.env ?? process.env;
	const isWSL = seams.isWSL ?? detectIsWSL;
	if (!isWSL()) return "n/a";

	const mode = env.DG_WSL_NETWORKING_MODE
		? (env.DG_WSL_NETWORKING_MODE as WslNetworkingMode)
		: seams.networkingMode
			? await seams.networkingMode()
			: await detectNetworkingMode();

	if (mode === "nat") {
		throw new DgCliError(
			`dg-server refuses to start on WSL in NAT networking mode: ${REMEDIATION}`,
			EXIT_WSL_NAT_NETWORKING,
		);
	}
	return mode;
}
