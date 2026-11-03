/**
 * `demo` — play a declarative tour in a local browser by default; with --ext,
 * hand it to the dg-ai-extension instead. Encodes the
 * script into a `_demo` fragment marker on its startUrl and opens it in the
 * default browser; the extension plays the tour, then strips the marker. Also
 * saves a re-runnable plan.md so the tour can be replayed later via `rerun`.
 * Compile-once, play-many — no live channel.
 */

import { tryOpen } from "@dg/common/node";
import type { LocalDeps, LocalOpts } from "./local";
import { findPlan, loadScript, savePlan } from "./plan-file";
import { addDemoMarker } from "../utils/demo-marker";
import type { VerifyResult } from "../utils/demo-verify";
import type { TourScript } from "../utils/plan-format";

export { loadScript, savePlan };

export type PlayOpts = {
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
	return (await import("./verify-local")).verifyLocal(script);
};

const defaultDemoDeps = async (): Promise<DemoDeps> => ({
	play: (script, opts) => playScript(script, opts),
	local: (await import("./local")).defaultLocalDeps,
	verify: defaultVerify,
});

async function resolveDeps(deps: Partial<DemoDeps>): Promise<DemoDeps> {
	return { ...(await defaultDemoDeps()), ...deps };
}

export type CommandOpts = PlayOpts &
	Omit<LocalOpts, "video"> & { verify?: string };

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
			process.exitCode = 1;
			return;
		}
		return play(script, opts);
	}
	const { playLocal } = await import("./local");
	const code = await playLocal(script, opts, local);
	if (code !== 0) process.exitCode = code;
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
	await Bun.write(Bun.stdout, `${JSON.stringify(result)}\n`);
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

export async function runDemo(
	scriptPath: string | undefined,
	opts: CommandOpts,
	deps: Partial<DemoDeps>,
): Promise<void> {
	if (opts.verify) return runVerify(opts.verify, opts, deps);
	if (!scriptPath) {
		console.error("demo: a script path is required (or use --verify <plan.md>)");
		process.exitCode = 1;
		return;
	}
	return dispatchPlay("demo", loadScript(scriptPath), opts, deps);
}

export async function runRerun(
	plan: string,
	opts: CommandOpts,
	deps: Partial<DemoDeps>,
): Promise<void> {
	return dispatchPlay("rerun", loadScript(findPlan(plan)), opts, deps);
}
