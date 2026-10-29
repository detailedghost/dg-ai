import type { Command } from "commander";

/** Registers pass-through inbox/profile commands so Commander preserves provider-specific workflow flags. */
export function registerInbox(program: Command): void {
	program
		.command("inbox")
		.description(
			"Review Proton Mail, Gmail, and Outlook with redacted inbox workflows and DB profiles.",
		)
		.helpOption(false)
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.argument("[args...]", "Inbox workflow or profile arguments")
		.action(async (args: string[]) => {
			const { runInbox } = await import("../inbox/cli");
			await runInbox(args);
		});
}
