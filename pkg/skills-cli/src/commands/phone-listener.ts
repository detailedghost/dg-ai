import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cliDest } from "../utils/lib";

/** Long enough for `phone __refresh` to stop a listener and start its replacement. */
const REFRESH_TIMEOUT_MS = 8_000;

/** Restarts a drifted phone listener. A missing or older dg-agent binary is ignored. */
export function refreshPhoneListener(agentPath: string = cliDest("dg-agent"), spawn: typeof spawnSync = spawnSync): void {
	if (!existsSync(agentPath)) return;
	try {
		spawn(agentPath, ["phone", "__refresh"], { stdio: "ignore", timeout: REFRESH_TIMEOUT_MS });
	} catch {}
}
