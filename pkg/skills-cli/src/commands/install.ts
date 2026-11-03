import type { Command } from "commander";
import type { InstallOptions } from "../install/cli";

export function registerInstall(program: Command): void {
	program
		.command("install")
		.description(
			"stage the dg-ai-extension for loading + install the pinned Bun runtime, the dg bundle and the dg-skills, dg-agent and dg-daemon launchers, or copy skill instruction files with --skills-only",
		)
		.argument(
			"[target]",
			"chrome (default; serves Brave/Edge/Vivaldi) | firefox",
		)
		.option("--local", "build from pkg/extension instead of the GitHub release")
		.option("--repo <path>", "dg repo to build from (default: search up from cwd)")
		.option(
			"--cli-only",
			"install the runtime, bundle and launchers; skip the extension",
		)
		.option(
			"--agent-only",
			"install the runtime, bundle and launchers; skip the extension, for a non-Claude agent that only needs phone",
		)
		.option(
			"--skills-only",
			"copy plugins/dg/skills instruction files only; fetch no binaries and run no skill content",
		)
		.option(
			"--dest <path>",
			"directory for --skills-only (default: $DG_SKILLS_DEST, else the skills folder in the dg data dir)",
		)
		.option(
			"--keep-cache",
			"leave old dg plugin versions in the Claude plugin cache",
		)
		.option(
			"--version <x.y.z>",
			"pin every part to the vX.Y.Z release instead of the newest; fails before any change if a pinned release does not exist",
		)
		.action(async (target: string | undefined, opts: InstallOptions) => {
			const { runInstall } = await import("../install/cli");
			await runInstall(target, opts);
		});
}
