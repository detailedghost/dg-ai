import type { Command } from "commander";
import { main } from "../skill-audit";
import { registerRawCommand } from "../utils/legacy-command";

/** Register skill-audit with its raw parser; usage error and issues-found both exit non-zero. */
export function registerSkillAudit(program: Command): void {
	registerRawCommand(program, {
		name: "skill-audit",
		description: "Token-weight and hygiene report for skill directories",
		run: main,
	});
}
