import { DgCliError, EXIT_WSL_NAT_NETWORKING } from "@dg/common";
import { isWSL as detectIsWSL, runCapture } from "@dg/common/node";

export type WslNetworkingMode = "mirrored" | "nat" | "unknown";

export type WslGuardSeams = {
	isWSL?: () => boolean;
	networkingMode?: () => Promise<WslNetworkingMode>;
	env?: Record<string, string | undefined>;
};

const REMEDIATION =
	"loopback is only reachable from a Windows-side browser when WSL uses mirrored networking. " +
	"Set networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig on the Windows side, then run `wsl --shutdown` and restart.";

async function detectNetworkingMode(): Promise<WslNetworkingMode> {
	try {
		const profile = await runCapture("cmd.exe", [
			"/c",
			"echo",
			"%USERPROFILE%",
		]);
		if (profile.status !== 0) return "unknown";
		const winPath = `${profile.stdout.replace(/\r?\n$/, "")}\\.wslconfig`;
		const linuxPath = await runCapture("wslpath", ["-u", winPath]);
		if (linuxPath.status !== 0) return "unknown";
		const contents = await runCapture("cat", [linuxPath.stdout.trim()]);
		if (contents.status !== 0) return "nat";
		const match = contents.stdout.match(/networkingMode\s*=\s*(\w+)/i);
		if (!match) return "nat";
		return match[1].toLowerCase() === "mirrored" ? "mirrored" : "nat";
	} catch {
		return "unknown";
	}
}

const NETWORKING_MODES: WslNetworkingMode[] = ["mirrored", "nat", "unknown"];

function asNetworkingMode(raw: string): WslNetworkingMode {
	const mode = raw.trim().toLowerCase();
	if (!NETWORKING_MODES.includes(mode as WslNetworkingMode)) {
		throw new DgCliError(
			`DG_WSL_NETWORKING_MODE must be one of ${NETWORKING_MODES.join(", ")}, got "${raw}"`,
			EXIT_WSL_NAT_NETWORKING,
		);
	}
	return mode as WslNetworkingMode;
}

async function resolveNetworkingMode(
	env: Record<string, string | undefined>,
	seams: WslGuardSeams,
): Promise<WslNetworkingMode> {
	const override = env.DG_WSL_NETWORKING_MODE;
	if (override) return asNetworkingMode(override);
	if (seams.networkingMode) return seams.networkingMode();
	return detectNetworkingMode();
}

export async function checkWslNetworking(
	seams: WslGuardSeams = {},
): Promise<WslNetworkingMode | "n/a"> {
	const env = seams.env ?? process.env;
	const isWSL = seams.isWSL ?? detectIsWSL;
	if (!isWSL()) return "n/a";

	const mode = await resolveNetworkingMode(env, seams);

	if (mode === "nat") {
		throw new DgCliError(
			`dg-daemon refuses to start on WSL in NAT networking mode: ${REMEDIATION}`,
			EXIT_WSL_NAT_NETWORKING,
		);
	}
	return mode;
}
