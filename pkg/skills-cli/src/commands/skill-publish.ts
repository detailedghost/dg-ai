import type { Command } from "commander";
import { main } from "../skill-publish";
import { registerRawCommand } from "../utils/legacy-command";

/** Register skill-publish with its raw parser; each nested verb keeps its own usage/exit codes. */
export function registerSkillPublish(program: Command): void {
	registerRawCommand(program, {
		name: "skill-publish",
		description: "Package a Bun-TS CLI as an MCP server, or bundle skills into the dg plugin",
		run: main,
	});
}
