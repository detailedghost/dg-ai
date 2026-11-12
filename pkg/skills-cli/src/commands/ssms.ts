import type { Command } from "commander";

export function registerSsms(program: Command): void {
	program
		.command("ssms")
		.description(
			"Read and clean SMS. google drives Messages for Web; signal wraps signal-cli.",
		)
		.helpOption(false)
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.argument("[args...]", "provider, verb, and options")
		.action(async (args: string[] = []) => {
			const { runSsmsCommand } = await import("../ssms/cli");
			process.exitCode = await runSsmsCommand(args);
		});
}
