/**
 * `demo` — hand a declarative tour script to the dg-ai-extension. Encodes the
 * script into a `_demo` fragment marker on its startUrl and opens it in the
 * default browser; the extension plays the tour, then strips the marker. Also
 * saves a re-runnable plan.md so the tour can be replayed later via `rerun`.
 * Compile-once, play-many — no live channel.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { slugify } from "@dg/common";
import type { Command } from "commander";
import { addDemoMarker } from "../utils/demo-marker";
import type { VerifyResult } from "../utils/demo-verify";
import { verifyScript } from "../utils/demo-verify";
import { tryOpen } from "@dg/common/node";
import {
	parsePlanMarkdown,
	type TourScript,
	toPlanMarkdown,
	validate,
} from "../utils/plan-format";

/** Save a re-runnable plan.md under ~/.dg/demos/<slug>/ and return its path. */
export function savePlan(script: TourScript): string {
	const slug = slugify(script.title ?? "demo");
	const dir = join(homedir(), ".dg", "demos", slug);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${slug}.demo.md`);
	writeFileSync(path, toPlanMarkdown(script));
	return path;
}

/**
 * Load a tour from a plan file. `.md` is the human-authored form (frontmatter +
 * "## Steps" list) parsed into a script; anything else is treated as raw JSON.
 */
export function loadScript(path: string): TourScript {
	const raw = readFileSync(path, "utf8");
	const parsed = path.endsWith(".md")
		? parsePlanMarkdown(raw)
		: JSON.parse(raw);
	return validate(parsed);
}

type PlayOpts = { video?: boolean; print?: boolean; edit?: boolean };
type VerifyOpts = { verify?: string };

/**
 * Walk a plan in a real throwaway browser and print `{ok, findings[]}` as the sole
 * line of stdout — an unreadable plan or a harness failure is reported the same way,
 * never an unhandled throw, so a caller can always `JSON.parse` this line.
 */
export async function runVerify(planPath: string): Promise<void> {
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
	let result: VerifyResult;
	try {
		result = await verifyScript(script);
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
	console.log(JSON.stringify(result));
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
		`plan saved: ${planPath}\nre-run with: dg-browser rerun "${planPath}"`,
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

export function registerDemo(program: Command): void {
	program
		.command("demo")
		.description(
			"play a guided tour from a script.json via the dg-ai-extension",
		)
		.argument(
			"[script]",
			"path to a tour plan (.md) or script JSON file — omit with --verify",
		)
		.option(
			"--video",
			"record the tour to a video (auto-play) instead of a live walkthrough",
		)
		.option("--print", "print the marked URL instead of opening it")
		.option(
			"--edit",
			"open a review/edit panel in the browser before playing or recording",
		)
		.option(
			"--verify <plan>",
			"walk the plan in a real throwaway browser and print findings as JSON, instead of playing it",
		)
		.action((scriptPath: string | undefined, opts: PlayOpts & VerifyOpts) => {
			if (opts.verify) return runVerify(opts.verify);
			if (!scriptPath) {
				console.error(
					"demo: a script path is required (or use --verify <plan.md>)",
				);
				process.exit(1);
			}
			return playScript(loadScript(scriptPath), opts);
		});
}
