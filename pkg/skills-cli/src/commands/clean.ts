import type { Command } from "commander";

export function registerClean(program: Command): void {
	program
		.command("clean")
		.description("remove the leftovers of the move from ~/.dg: empty copies that were set aside, and an empty ~/.dg")
		.action(async () => {
			const { runClean } = await import("../install/clean");
			process.exitCode = await runClean();
		});
}
