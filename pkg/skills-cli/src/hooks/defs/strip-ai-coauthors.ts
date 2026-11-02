import { readFileSync, writeFileSync } from "node:fs";
import { autoCommentChar, stripAiCoauthors } from "@dg/common";
import { hookSetting } from "../config";
import type { CommandRunner, HookEnv } from "../types";

export const STRIP_ID = "strip-ai-coauthors";

export interface StripResolution {
	on: boolean;
	saved: string;
	override?: "1" | "0";
}

/** DG_STRIP_AI_COAUTHORS=1 forces on, 0 forces off, anything else uses the saved `enabled` setting. */
export function resolveStripAiCoauthors(
	env: HookEnv,
	warn?: (message: string) => void,
): StripResolution {
	const saved = hookSetting(STRIP_ID, "enabled", env, warn);
	const value = env["DG_STRIP_AI_COAUTHORS"];
	const override = value === "1" || value === "0" ? value : undefined;
	const on = override ? override === "1" : saved === "on";
	return override ? { on, saved, override } : { on, saved };
}

export function describeStripResolution({ on, saved, override }: StripResolution): string {
	const state = on ? "on" : "off";
	return override
		? `${state} (DG_STRIP_AI_COAUTHORS=${override} overrides saved ${saved})`
		: state;
}

const UTF8_NAME = /^(?:utf-?8)?$/i;

function decodeUtf8(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return undefined;
	}
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
	if (!resolveStripAiCoauthors(env).on) return;
	const bytes = readFileSync(file);
	const message = decodeUtf8(bytes);
	if (message === undefined) return;
	const encoding = await run(["git", "config", "--get", "i18n.commitEncoding"]);
	if (encoding.status === 0 && !UTF8_NAME.test(encoding.stdout.trim())) return;
	const config = await run(["git", "config", "--get", "core.commentChar"]);
	const configured = config.status === 0 ? config.stdout.trim() : "";
	const stripped = stripAiCoauthors(message, commentCharOf(configured, message));
	if (stripped !== message) writeFileSync(file, stripped);
}
