import type { Command } from "commander";
import type { OverwatchSnapshotOptions } from "../overwatch-snapshot/cli";

export function registerOverwatchSnapshot(program: Command): void {
	program
		.command("overwatch-snapshot")
		.description("render an Overwatch board JSON snapshot as read-only HTML")
		.option("--input <file>", "board JSON file, or - for stdin", "-")
		.option("--out <file>", "HTML output path")
		.option("--throttle-key <name>", "skip renders within 120 seconds for this key")
		.action(async (options: OverwatchSnapshotOptions) => {
			const { runOverwatchSnapshot } = await import("../overwatch-snapshot/cli");
			await runOverwatchSnapshot(options);
		});
}
