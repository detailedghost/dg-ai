import { readFileSync, writeFileSync } from "node:fs";
import { autoCommentChar, stripAiCoauthors } from "@dg/common";
import { hookSetting } from "../config";
import type { CommandRunner, HookEnv } from "../types";

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

function commentCharOf(configured: string, message: string): string {
	if (configured === "") return "#";
	if (configured !== "auto") return configured.slice(0, 1);
	return autoCommentChar(message);
}

export async function stripCommitMessageFile(
	file: string,
	env: HookEnv,
	run: CommandRunner,
): Promise<void> {
	if (!stripAiCoauthorsOn(env)) return;
	const message = readFileSync(file, "utf8");
	const config = await run(["git", "config", "--get", "core.commentChar"]);
	const configured = config.status === 0 ? config.stdout.trim() : "";
	const stripped = stripAiCoauthors(message, commentCharOf(configured, message));
	if (stripped !== message) writeFileSync(file, stripped);
}
