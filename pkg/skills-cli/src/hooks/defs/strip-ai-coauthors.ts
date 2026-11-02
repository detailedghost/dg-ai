import { readFileSync, writeFileSync } from "node:fs";
import { stripAiCoauthors } from "@dg/common";
import { hookSetting } from "../config";
import type { HookEnv } from "../types";

export const STRIP_ID = "strip-ai-coauthors";

/** True when DG_STRIP_AI_COAUTHORS is 1, or unset and the `enabled` setting is on. */
export function stripAiCoauthorsOn(
	env: HookEnv,
	warn?: (message: string) => void,
): boolean {
	const override = env["DG_STRIP_AI_COAUTHORS"];
	if (override === "1") return true;
	if (override === "0") return false;
	return hookSetting(STRIP_ID, "enabled", env, warn) === "on";
}

export function stripCommitMessageFile(file: string, env: HookEnv): void {
	if (!stripAiCoauthorsOn(env)) return;
	const message = readFileSync(file, "utf8");
	const stripped = stripAiCoauthors(message);
	if (stripped !== message) writeFileSync(file, stripped);
}
