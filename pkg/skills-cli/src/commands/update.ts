import type { Command } from "commander";

export function registerUpdate(program: Command): void {
	program
		.command("update")
		.description(
			"update every dg part to the newest release: the Bun runtime, the dg bundle and launchers, the staged extension, and the dg plugin for Claude and Codex; then run doctor",
		)
		.option("--check", "print installed and newest versions; change nothing")
		.action(async (opts: { check?: boolean }) => {
			const { defaultUpdateDeps, runUpdate } = await import("../update/run");
			process.exitCode = await runUpdate(opts, defaultUpdateDeps());
		});
}
