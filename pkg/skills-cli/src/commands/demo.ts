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
import type { Command } from "commander";
import { addDemoMarker } from "../utils/demo-marker";
import { tryOpen } from "../utils/lib";
import {
	parsePlanMarkdown,
	type TourScript,
	toPlanMarkdown,
	validate,
} from "../utils/plan-format";

function slugify(s: string): string {
	return s.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "demo";
}

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
		.argument("<script>", "path to a tour plan (.md) or script JSON file")
		.option(
			"--video",
			"record the tour to a video (auto-play) instead of a live walkthrough",
		)
		.option("--print", "print the marked URL instead of opening it")
		.option(
			"--edit",
			"open a review/edit panel in the browser before playing or recording",
		)
		.action((scriptPath: string, opts: PlayOpts) => {
			return playScript(loadScript(scriptPath), opts);
		});
}
