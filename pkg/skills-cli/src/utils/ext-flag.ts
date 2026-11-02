import type { Command } from "commander";

export const EXT_FLAG = "--ext";

export function addExtOption(command: Command): Command {
	return command.option(
		EXT_FLAG,
		"use the dg-ai-extension instead of the local default",
	);
}
