import type { Command } from "commander";
import { registerRawCommand } from "../utils/legacy-command";

export function registerPwCode(program: Command): void {
	registerRawCommand(program, {
		name: "pw-code",
		description: "Run code inside a pw browser session (asks every time)",
		run: async (argv) => {
			const { protectedSessionRefusal } = await import(
				"../pw/core/protected-session"
			);
			const refusal = protectedSessionRefusal(argv, "pw-code");
			if (refusal) {
				process.stderr.write(`${refusal}\n`);
				return 2;
			}
			return (await import("../pw/code-cli")).main(argv);
		},
	});
}
