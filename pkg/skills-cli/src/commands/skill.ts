import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

export function registerSkill(program: Command): void {
	registerLazyRaw(program, {
		name: "skill",
		description: "Audit skill directories for token weight and hygiene, and split oversized SKILL.md files",
		load: () => import("../skill"),
	});
}
