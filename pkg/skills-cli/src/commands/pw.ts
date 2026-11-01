import type { Command } from "commander";
import { registerRawCommand } from "../utils/legacy-command";

export function registerPw(program: Command): void {
	registerRawCommand(program, {
		name: "pw",
		description: "Drive a browser from the command line",
		run: async (argv) => (await import("../pw/cli")).main(argv),
	});
}
