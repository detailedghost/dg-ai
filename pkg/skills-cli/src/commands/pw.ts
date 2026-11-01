import type { Command } from "commander";
import { registerRawCommand } from "../utils/legacy-command";

export function registerPw(program: Command): void {
	registerRawCommand(program, {
		name: "pw",
		description: "Drive a browser from the command line",
		run: async (argv) => {
			const { protectedSessionRefusal } = await import(
				"../pw/core/protected-session"
			);
			const refusal = protectedSessionRefusal(argv);
			if (refusal) {
				process.stderr.write(`${refusal}\n`);
				return 2;
			}
			return (await import("../pw/cli")).main(argv);
		},
	});
}
