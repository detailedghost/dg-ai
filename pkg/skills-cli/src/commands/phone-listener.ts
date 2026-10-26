import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cliDest } from "../utils/lib";

/** Long enough for `phone __refresh` to stop a listener and start its replacement. */
const REFRESH_TIMEOUT_MS = 8_000;

function stderrText(stderr: unknown): string {
	if (typeof stderr === "string") return stderr;
	if (stderr instanceof Uint8Array) return new TextDecoder().decode(stderr);
	return "";
}

function lastLine(text: string): string {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1) ?? "";
}

/** A spawn that did not exit 0. An empty test double is not a failure. */
function refreshFailed(result: { error?: Error; status?: number | null }): boolean {
	if (result.error) return true;
	if (result.status === null) return true;
	return typeof result.status === "number" && result.status !== 0;
}

/** Restarts a drifted phone listener. A missing binary is ignored; a failed refresh is a warning. */
export function refreshPhoneListener(agentPath: string = cliDest("dg-agent"), spawn: typeof spawnSync = spawnSync): void {
	if (!existsSync(agentPath)) return;
	try {
		const result = spawn(agentPath, ["phone", "__refresh"], {
			stdio: ["ignore", "ignore", "pipe"],
			encoding: "utf8",
			timeout: REFRESH_TIMEOUT_MS,
		});
		if (!refreshFailed(result)) return;
		const detail = lastLine(stderrText(result.stderr)) || result.error?.message || `exit ${result.status}`;
		console.warn(`warning: phone listener was not refreshed: ${detail}`);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.warn(`warning: phone listener was not refreshed: ${detail}`);
	}
}
