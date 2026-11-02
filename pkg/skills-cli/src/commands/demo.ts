/**
 * `demo` — play a declarative tour in a local browser by default; with --ext,
 * hand it to the dg-ai-extension instead. Encodes the
 * script into a `_demo` fragment marker on its startUrl and opens it in the
 * default browser; the extension plays the tour, then strips the marker. Also
 * saves a re-runnable plan.md so the tour can be replayed later via `rerun`.
 * Compile-once, play-many — no live channel.
 */

import { InvalidArgumentError, Option, type Command } from "commander";
import { tryOpen } from "@dg/common/node";
import type { LocalDeps, LocalOpts } from "../demo/local";
import { loadScript, savePlan } from "../demo/plan-file";
import { addDemoMarker } from "../utils/demo-marker";
import type { VerifyResult } from "../utils/demo-verify";
import { addExtOption } from "../utils/ext-flag";
import type { TourScript } from "../utils/plan-format";

export { loadScript, savePlan };

type PlayOpts = {
	video?: boolean;
	print?: boolean;
	edit?: boolean;
	ext?: boolean;
};

type VerifyFn = (
	script: TourScript,
	opts: { ext: boolean },
) => Promise<VerifyResult>;

export type DemoDeps = {
	play: typeof playScript;
	local: LocalDeps;
	verify: VerifyFn;
};

const defaultVerify: VerifyFn = async (script, { ext }) => {
	if (ext) return (await import("../utils/demo-verify")).verifyScript(script);
	return (await import("../demo/verify-local")).verifyLocal(script);
};

const defaultDemoDeps = async (): Promise<DemoDeps> => ({
	play: (script, opts) => playScript(script, opts),
	local: (await import("../demo/local")).defaultLocalDeps,
	verify: defaultVerify,
});

async function resolveDeps(deps: Partial<DemoDeps>): Promise<DemoDeps> {
	return { ...(await defaultDemoDeps()), ...deps };
}

export type CommandOpts = PlayOpts &
	Omit<LocalOpts, "video"> & { verify?: string };

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
		.addOption(
			new Option(
				"--narration <mode>",
				"with --video: voiceover and captions (both), voiceover only (voice) or silent (captions); default is the saved start-screen choice",
			).choices(["both", "voice", "captions"]),
		)
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

const LOCAL_ONLY_FLAGS = [
	["out", "--out"],
	["narration", "--narration"],
	["browser", "--browser"],
	["windows", "--windows"],
	["wslHeaded", "--wsl-headed"],
	["timeout", "--timeout"],
] as const;

export async function dispatchPlay(
	name: "demo" | "rerun",
	script: TourScript,
	opts: CommandOpts,
	deps: Partial<DemoDeps>,
): Promise<void> {
	const { play, local } = await resolveDeps(deps);
	if (opts.ext) {
		const local = LOCAL_ONLY_FLAGS.filter(([key]) => opts[key]);
		if (local.length > 0) {
			console.error(
				`${name}: ${local.map(([, flag]) => flag).join(", ")} need local mode; drop --ext`,
			);
			process.exit(1);
		}
		return play(script, opts);
	}
	const { playLocal } = await import("../demo/local");
	const code = await playLocal(script, opts, local);
	if (code !== 0) process.exit(code);
}

/**
 * Walk a plan in a real throwaway browser and print `{ok, findings[]}` as the sole
 * line of stdout — an unreadable plan or a harness failure is reported the same way,
 * never an unhandled throw, so a caller can always `JSON.parse` this line.
 */
export async function runVerify(
	planPath: string,
	opts: { ext?: boolean } = {},
	deps: Partial<DemoDeps> = {},
): Promise<void> {
	let script: TourScript;
	try {
		script = loadScript(planPath);
	} catch (err) {
		console.log(
			JSON.stringify({
				ok: false,
				findings: [
					{
						step: 0,
						kind: "plan-unreadable",
						message: err instanceof Error ? err.message : String(err),
					},
				],
			} satisfies VerifyResult),
		);
		return;
	}
	const { verify } = await resolveDeps(deps);
	let result: VerifyResult;
	try {
		result = await verify(script, { ext: opts.ext === true });
	} catch (err) {
		result = {
			ok: false,
			findings: [
				{
					step: 0,
					kind: "harness-error",
					message: err instanceof Error ? err.message : String(err),
				},
			],
		};
	}
	/**
	 * Exit rather than fall off the end. The browser's own children inherit its
	 * piped stderr and outlive it, so that pipe never reaches EOF and the runtime
	 * keeps this process alive with no work left to do. The findings are the whole
	 * deliverable, so once they are written there is nothing to stay open for.
	 */
	await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
	process.exit(0);
}

/** Encode the tour into a `_demo` URL, save its plan, and open it (or just print). */
export async function playScript(
	script: TourScript,
	opts: PlayOpts,
): Promise<void> {
	if (opts.video) script.mode = "video";
	const url = addDemoMarker(script.startUrl, script, opts.edit);
	if (opts.print) {
		console.log(url);
		return;
	}
	const planPath = savePlan(script);
	const ok = await tryOpen(url);
	console.log(`${ok ? "opened" : "FAILED"}: ${script.startUrl}`);
	const kind = script.mode === "video" ? "video demo" : "walkthrough";
	console.log(
		`\n${kind} "${script.title ?? "demo"}" (${script.steps.length} step(s)) handed to dg-ai-extension.`,
	);
	console.log(
		`plan saved: ${planPath}\nre-run with: dg-skills rerun --ext "${planPath}"`,
	);
	if (opts.edit)
		console.log(
			"In the browser: review/edit the steps in the on-page panel, then Download the plan or hit Play / Record.",
		);
	else if (script.mode === "video")
		console.log(
			"In the browser: press Alt+Shift+D to start recording. A .zip (video + plan) saves to your Downloads/dg-demo/ folder.",
		);
}

export function registerDemo(
	program: Command,
	deps: Partial<DemoDeps> = {},
): void {
	const demo = addLocalOptions(
		addExtOption(program.command("demo"))
			.description(
				"play a guided tour in a local browser, or through the dg-ai-extension with --ext",
			)
			.argument(
				"[script]",
				"path to a tour plan (.md) or script JSON file — omit with --verify",
			)
			.option(
				"--video",
				"record the tour to a video now, with no start screen",
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
	demo.action((scriptPath: string | undefined, opts: CommandOpts) => {
		if (opts.verify) return runVerify(opts.verify, opts, deps);
		if (!scriptPath) {
			console.error(
				"demo: a script path is required (or use --verify <plan.md>)",
			);
			process.exit(1);
		}
		return dispatchPlay("demo", loadScript(scriptPath), opts, deps);
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
		.command("__player", { hidden: true })
		.argument("<job>", "the player job as JSON")
		.action(async (job: string) => {
			const { servePlayer } = await import("../demo/local");
			process.exit(await servePlayer(job));
		});
}
