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

type PlayOpts = { video?: boolean; print?: boolean };

/** Encode the tour into a `_demo` URL, save its plan, and open it (or just print). */
export async function playScript(
	script: TourScript,
	opts: PlayOpts,
): Promise<void> {
	if (opts.video) script.mode = "video";
	const url = addDemoMarker(script.startUrl, script);
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
	if (script.mode === "video")
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
		.argument("<script>", "path to a tour script JSON file")
		.option(
			"--video",
			"record the tour to a video (auto-play) instead of a live walkthrough",
		)
		.option("--print", "print the marked URL instead of opening it")
		.action((scriptPath: string, opts: PlayOpts) => {
			const script = validate(JSON.parse(readFileSync(scriptPath, "utf8")));
			return playScript(script, opts);
		});
}
