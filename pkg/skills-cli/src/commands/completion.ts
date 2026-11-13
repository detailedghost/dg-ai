import type { Command } from "commander";

export function registerCompletion(program: Command): void {
	program
		.command("completion")
		.description(
			"print the bash, zsh or fish completion script, or write or remove the completion files of dg-skills, dg-agent and dg-daemon",
		)
		.addArgument(program.createArgument("[shell]", "bash, zsh or fish").choices(["bash", "zsh", "fish"]))
		.option("--install", "write the completion files for every shell to the per-user folders")
		.option("--uninstall", "remove the completion files that dg wrote")
		.action(async (shell: "bash" | "zsh" | "fish" | undefined, opts: { install?: boolean; uninstall?: boolean }) => {
			const { runCompletion } = await import("../completion/cli");
			process.exitCode = runCompletion(shell, opts);
		});
}
