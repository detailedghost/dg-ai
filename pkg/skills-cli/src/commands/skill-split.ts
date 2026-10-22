import type { Command } from "commander";
import { main } from "../skill-split";
import { registerRawCommand } from "../utils/legacy-command";

/** Register skill-split with its raw parser; --list/--apply both keep the legacy exit-2 usage contract. */
export function registerSkillSplit(program: Command): void {
	registerRawCommand(program, {
		name: "skill-split",
		description: "Move SKILL.md sections verbatim into references/ files",
		run: main,
	});
}
