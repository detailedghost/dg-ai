import type { Command } from "commander";

export function registerUpdate(program: Command): void {
	program
		.command("update")
		.description(
			"update every dg part to the newest release: the Bun runtime, the dg bundle and launchers, the staged extension, and the dg plugin for Claude and Codex; then run doctor",
		)
		.option("--version <x.y.z>", "update to the vX.Y.Z release instead of the newest")
		.option("--check", "print installed and newest versions; change nothing")
		.action(async (opts: { version?: string; check?: boolean }) => {
			const { defaultUpdateDeps, runUpdate } = await import("../update/run");
			process.exitCode = await runUpdate(opts, defaultUpdateDeps());
		});
}
