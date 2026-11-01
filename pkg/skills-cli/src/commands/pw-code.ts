import type { Command } from "commander";
import { registerRawCommand } from "../utils/legacy-command";

export function registerPwCode(program: Command): void {
	registerRawCommand(program, {
		name: "pw-code",
		description: "Run code inside a pw browser session (asks every time)",
		run: async (argv) => (await import("../pw/code-cli")).main(argv),
	});
}
