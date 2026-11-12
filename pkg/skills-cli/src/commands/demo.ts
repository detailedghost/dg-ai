import { InvalidArgumentError, Option, type Command } from "commander";
import type { CommandOpts, DemoDeps } from "../demo/cli";
import { addExtOption } from "../utils/ext-flag";

function positiveMinutes(value: string): number {
	const minutes = Number(value);
	if (!(minutes > 0)) throw new InvalidArgumentError("use a number above 0");
	return minutes;
}

export function addLocalOptions(command: Command): Command {
	return command
		.option("--out <path>", "where the video file goes")
		.addOption(
			new Option("--browser <name>", "skip the system-first browser pick").choices(
				["chrome", "msedge", "chromium"],
			),
		)
		.option("-n, --narration", "add a voiceover to the recording")
		.option("--windows", "WSL: drive the Windows-side browser over CDP")
		.option(
			"--wsl-headed",
			"WSL: headed browser inside WSL (experimental; only when the human asks)",
		)
		.option(
			"--timeout <min>",
			"minutes to wait for the human before the player stops (default 30)",
			positiveMinutes,
		);
}

export function registerDemo(
	program: Command,
	deps: Partial<DemoDeps> = {},
): void {
	const demo = addLocalOptions(
		addExtOption(program.command("demo"))
			.description(
				"record a guided tour to an MP4 in a local browser, or play it through the dg-ai-extension with --ext",
			)
			.argument(
				"[script]",
				"path to a tour plan (.md) or script JSON file — omit with --verify",
			)
			.option(
				"--video",
				"--ext: start in video mode; local mode always records",
			)
			.option("--print", "--ext only: print the marked URL instead of opening it")
			.option(
				"--edit",
				"--ext only: open a review/edit panel in the browser before playing",
			)
			.option(
				"--verify <plan>",
				"walk the plan in a real throwaway browser and print findings as JSON, instead of playing it",
			),
	);
	demo.action(async (scriptPath: string | undefined, opts: CommandOpts) => {
		const { runDemo } = await import("../demo/cli");
		await runDemo(scriptPath, opts, deps);
	});
	demo
		.command("status")
		.description("print the result of the last run of a saved demo")
		.argument("<slug>", "the demo slug printed when the run started")
		.action(async (slug: string) => {
			const { statusLine } = await import("../demo/result");
			console.log(statusLine(slug));
		});
	demo
		.command("player")
		.description("Serve the demo player; dg starts this for you")
		.argument("<job>", "the player job as JSON")
		.action(async (job: string) => {
			const { servePlayer } = await import("../demo/local");
			process.exitCode = await servePlayer(job);
		});
}
