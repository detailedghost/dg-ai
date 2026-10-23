/**
 * `demo` — play a declarative tour script. Local is the default: `dg-skills pw`
 * drives a real Chromium to record a video and a light/dark before/after
 * screenshot pair, rendering each step through the shared overlay module
 * (pkg/common/src/tour-overlay.ts). `--ext` hands the script to the
 * dg-ai-extension instead (today's behavior, unchanged): it encodes the script
 * into a `_demo` fragment marker on its startUrl and opens it in the default
 * browser; the extension plays the tour, then strips the marker. Either way, a
 * re-runnable plan.md is saved so the tour can be replayed later via `rerun`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { slugify } from "@dg/common";
import { scratchDir, tryOpen } from "@dg/common/node";
import type { Command } from "commander";
import {
	describeAttachPrOutcome,
	resolveAttachPr,
} from "../demo/attach-pr";
import { captureBaseline, cleanupOwnedArtifacts } from "../demo/cleanup";
import { createPwDemoDriver, recordLocalDemo } from "../demo/local-record";
import { addDemoMarker } from "../utils/demo-marker";
import type { VerifyResult } from "../utils/demo-verify";
import { verifyScript } from "../utils/demo-verify";
import {
	parsePlanMarkdown,
	type TourScript,
	toPlanMarkdown,
	validate,
} from "../utils/plan-format";

/** New files this run may drop in the cwd that it, and only it, is allowed to clean up. */
const OWNED_ARTIFACT_PATTERNS = [
	/^before-(light|dark)\.png$/,
	/^after-(light|dark)\.png$/,
	/^recording\.webm$/,
];

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
type DemoOpts = PlayOpts &
	VerifyOpts & { ext?: boolean; attachPr?: string };

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
	opts: DemoOpts,
): Promise<void> {
	const cwd = process.cwd();
	const baseline = await captureBaseline(cwd);
	try {
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
			`plan saved: ${planPath}\nre-run with: dg-skills rerun "${planPath}"`,
		);
		if (opts.edit)
			console.log(
				"In the browser: review/edit the steps in the on-page panel, then Download the plan or hit Play / Record.",
			);
		else if (script.mode === "video")
			console.log(
				"In the browser: press Alt+Shift+D to start recording. A .zip (video + plan) saves to your Downloads/dg-demo/ folder.",
			);
		// The extension records client-side (into the user's Downloads); there's no
		// artifact file list yet here, only the PR to report against.
		if (opts.attachPr) {
			console.log(describeAttachPrOutcome(await resolveAttachPr(opts.attachPr, [])));
		}
	} finally {
		const removed = await cleanupOwnedArtifacts(cwd, baseline, OWNED_ARTIFACT_PATTERNS);
		if (removed.length > 0) {
			console.log(
				`cleaned up ${removed.length} owned artifact path(s) left in the working tree: ${removed.join(", ")}`,
			);
		}
	}
}

/** A session name `pw` accepts (letters/digits/._- , 48 chars max), unique per run. */
function demoSessionName(script: TourScript): string {
	return `dg-demo-${slugify(script.title ?? "demo")}-${randomUUID().slice(0, 8)}`.slice(0, 48);
}

/**
 * Drives `dg-skills pw` to record a local video + light/dark before/after screenshot
 * pair for `script`, prints the commands to reproduce/replay it locally, then — within
 * the same pre-run baseline — hands off `--attach-pr` and sweeps this run's own
 * artifacts out of the cwd before returning.
 */
async function runLocalDemo(script: TourScript, opts: DemoOpts): Promise<void> {
	const cwd = process.cwd();
	const baseline = await captureBaseline(cwd);
	const outputDir = scratchDir("demo");
	const driver = createPwDemoDriver(demoSessionName(script), outputDir, cwd);

	try {
		const artifacts = await recordLocalDemo(script, outputDir, driver);
		const planPath = savePlan(script);

		console.log(
			`local demo "${script.title ?? "demo"}" (${script.steps.length} step(s)) recorded.`,
		);
		console.log(
			[
				"screenshots:",
				`  before (light): ${artifacts.screenshots.beforeLight}`,
				`  before (dark):  ${artifacts.screenshots.beforeDark}`,
				`  after (light):  ${artifacts.screenshots.afterLight}`,
				`  after (dark):   ${artifacts.screenshots.afterDark}`,
			].join("\n"),
		);
		if (artifacts.video) console.log(`video: ${artifacts.video}`);
		console.log(
			`plan saved: ${planPath}\nre-run with: dg-skills demo "${planPath}"`,
		);

		if (opts.attachPr) {
			const files = [
				artifacts.screenshots.beforeLight,
				artifacts.screenshots.beforeDark,
				artifacts.screenshots.afterLight,
				artifacts.screenshots.afterDark,
				...(artifacts.video ? [artifacts.video] : []),
			];
			console.log(describeAttachPrOutcome(await resolveAttachPr(opts.attachPr, files)));
		}
	} finally {
		const removed = await cleanupOwnedArtifacts(cwd, baseline, OWNED_ARTIFACT_PATTERNS);
		if (removed.length > 0) {
			console.log(
				`cleaned up ${removed.length} owned artifact path(s) left in the working tree: ${removed.join(", ")}`,
			);
		}
	}
}

export function registerDemo(program: Command): void {
	program
		.command("demo")
		.description(
			"play a guided tour; local by default (dg-skills pw records it), --ext hands it to the dg-ai-extension",
		)
		.argument(
			"[script]",
			"path to a tour plan (.md) or script JSON file — omit with --verify",
		)
		.option(
			"--ext",
			"use the dg-ai-extension's browser-driven flow instead of a local recording",
		)
		.option(
			"--video",
			"record the tour to a video (auto-play) instead of a live walkthrough (--ext only; local mode decides this from the plan's mode)",
		)
		.option("--print", "print the marked URL instead of opening it (--ext only)")
		.option(
			"--edit",
			"open a review/edit panel in the browser before playing or recording (--ext only)",
		)
		.option(
			"--verify <plan>",
			"walk the plan in a real throwaway browser and print findings as JSON, instead of playing it",
		)
		.option(
			"--attach-pr <ref>",
			"hand this run's recorded files to the given PR/MR number or URL; no saved-login upload yet, so it never changes the PR",
		)
		.action(async (scriptPath: string | undefined, opts: DemoOpts) => {
			if (opts.verify) return runVerify(opts.verify);
			if (!scriptPath) {
				console.error(
					"demo: a script path is required (or use --verify <plan.md>)",
				);
				process.exit(1);
				return;
			}
			const script = loadScript(scriptPath);
			return selectDemoMode(opts) === "ext"
				? playScript(script, opts)
				: runLocalDemo(script, opts);
		});
}

/** The whole default-selection rule in one place: `--ext` opts in to the extension flow, everything else is local. */
export function selectDemoMode(opts: Pick<DemoOpts, "ext">): "local" | "ext" {
	return opts.ext ? "ext" : "local";
}
