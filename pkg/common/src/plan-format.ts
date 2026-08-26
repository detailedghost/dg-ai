/**
 * Tour-plan format + validation. A plan is a human-authored Markdown file: YAML
 * frontmatter (title / startUrl / mode / includeSetup), an optional "## Setup"
 * list, and a required "## Steps" list — one line per step, with each step's
 * timing shown inline. The CLI reads that human form and (re)generates the
 * machine-runnable TourScript into the "## Script" fenced json block.
 *
 * This module is pure and dependency-free — it is bundled into the browser extension
 * too. The markdown *reader* (which pulls in `marked`) lives CLI-side in
 * pkg/skills-cli/src/utils/plan-parse.ts.
 */

import type { StepAction, StepAdvance, TourScript, TourStep } from "./types";

function validateSteps(
	steps: unknown,
	prefix: string,
	allowEmpty = false,
): asserts steps is TourStep[] {
	if (!Array.isArray(steps)) throw new Error(`${prefix} must be an array`);
	if (!allowEmpty && steps.length === 0)
		throw new Error(`${prefix} must be a non-empty array`);
	steps.forEach((step: Record<string, unknown>, i) => {
		const label = prefix === "script.steps" ? `step ${i}` : `setup step ${i}`;
		if (!step || typeof step !== "object" || typeof step.body !== "string")
			throw new Error(`${label} must be an object with a string 'body'`);
		if (step.selector !== undefined && typeof step.selector !== "string")
			throw new Error(`${label}: 'selector' must be a string`);
		if (step.title !== undefined && typeof step.title !== "string")
			throw new Error(`${label}: 'title' must be a string`);
		if (
			step.advance !== undefined &&
			step.advance !== "next" &&
			step.advance !== "click" &&
			typeof step.advance !== "number"
		)
			throw new Error(
				`${label}: 'advance' must be 'next', 'click', or a number`,
			);
		if (
			step.navigate !== undefined &&
			(typeof step.navigate !== "string" || !/^https?:\/\//.test(step.navigate))
		)
			throw new Error(`${label}: 'navigate' must be an http(s) URL`);
		if (step.action !== undefined) {
			const a = step.action as Record<string, unknown>;
			if (a?.do === "fill") {
				if (typeof a.value !== "string")
					throw new Error(`${label}: fill action needs a string 'value'`);
			} else if (a?.do !== "click")
				throw new Error(`${label}: 'action.do' must be 'click' or 'fill'`);
		}
	});
}

/** Structural validation — the extension trusts what the CLI encodes. */
export function validate(script: unknown): TourScript {
	if (!script || typeof script !== "object")
		throw new Error("script must be a JSON object");
	const s = script as Record<string, unknown>;
	if (typeof s.startUrl !== "string" || !/^https?:\/\//.test(s.startUrl))
		throw new Error("script.startUrl must be an http(s) URL");
	validateSteps(s.steps, "script.steps");
	if (s.mode !== undefined && s.mode !== "walkthrough" && s.mode !== "video")
		throw new Error("script.mode must be 'walkthrough' or 'video'");
	if (s.setup !== undefined) {
		if (!s.setup || typeof s.setup !== "object")
			throw new Error("script.setup must be an object");
		const setup = s.setup as Record<string, unknown>;
		// An empty Setup section means "no preparation"; rejecting it discarded the
		// whole marker, since readDemoScript answers a validation failure with undefined.
		validateSteps(setup.steps, "script.setup.steps", true);
		if (typeof setup.includeInTour !== "boolean")
			throw new Error("script.setup.includeInTour must be a boolean");
	}
	return script as TourScript;
}

/** Split preparation from tutorial playback using the one public ordering rule. */
export function partitionTourSteps(script: TourScript): {
	setup: TourStep[];
	tutorial: TourStep[];
} {
	const setup = script.setup;
	if (!setup) return { setup: [], tutorial: script.steps };
	return setup.includeInTour
		? { setup: [], tutorial: [...setup.steps, ...script.steps] }
		: { setup: setup.steps, tutorial: script.steps };
}

/** Whether playback contains any authored click/fill action. */
export function tourHasAutomaticActions(script: TourScript): boolean {
	return (
		script.steps.some((step) => step.action != null) ||
		script.setup?.steps.some((step) => step.action != null) === true
	);
}

// --- advance <-> inline-timing token ---

/** Render a step's `advance` as the inline token shown at the end of its line. */
export function formatAdvance(advance: StepAdvance | undefined): string {
	if (advance === undefined) return "";
	if (typeof advance === "number") return `${advance / 1000}s`;
	return advance; // "next" | "click"
}

/**
 * Parse an inline timing token back to an `advance` value; returns undefined when
 * the token isn't a recognized timing (so a trailing code span in prose stays prose).
 * Accepts `4s`, `4.5s`, `4500ms`, a bare millisecond count, `click`, or `next`.
 */
export function parseAdvance(token: string): StepAdvance | undefined {
	const t = token.trim();
	if (t === "click" || t === "next") return t;
	let m = t.match(/^(\d+(?:\.\d+)?)s$/);
	if (m) return Math.round(Number(m[1]) * 1000);
	m = t.match(/^(\d+)ms$/);
	if (m) return Number(m[1]);
	if (/^\d+$/.test(t)) return Number(t);
	return undefined;
}

// --- action <-> inline token (@click / @type="…") ---

/** Render a step's `action` as its inline plan token, or "" when there is none. */
export function formatAction(action: StepAction | undefined): string {
	if (!action) return "";
	if (action.do === "click") return "@click";
	return `@type="${action.value.replace(/(["\\])/g, "\\$1")}"`;
}

/** Parse an `@click` / `@type="…"` token out of a step's meta segment. */
export function parseAction(meta: string): StepAction | undefined {
	const fill = meta.match(/@type="((?:[^"\\]|\\.)*)"/);
	if (fill) return { do: "fill", value: fill[1].replace(/\\(["\\])/g, "$1") };
	if (/@click\b/.test(meta)) return { do: "click" };
	return undefined;
}

// --- markdown <-> TourScript ---

/** Render a validated script as a readable, re-runnable plan (Markdown). */
export function toPlanMarkdown(script: TourScript): string {
	const fm = [
		"---",
		`title: ${script.title ?? "demo"}`,
		`startUrl: ${script.startUrl}`,
		`mode: ${script.mode ?? "walkthrough"}`,
		...(script.setup ? [`includeSetup: ${script.setup.includeInTour}`] : []),
		"---",
	];
	const lines = [
		...fm,
		"",
		"<!-- Play/record: dg-skills demo <this-file>  ·  Replay: dg-skills rerun <this-file> -->",
		"<!-- Edit the steps below; the CLI derives the runnable script from them. -->",
		"",
	];
	const appendSteps = (heading: string, steps: TourStep[]): void => {
		lines.push(heading, "");
		steps.forEach((step, i) => {
			const sel = step.selector ? ` \`${step.selector}\`` : "";
			const nav = step.navigate ? ` → ${step.navigate}` : "";
			const actTok = formatAction(step.action);
			const act = actTok ? ` ${actTok}` : "";
			const adv = formatAdvance(step.advance);
			const timing = adv ? ` \`${adv}\`` : "";
			lines.push(
				`${i + 1}. **${step.title ?? "Step"}**${sel}${nav}${act} — ${step.body}${timing}`,
			);
		});
		lines.push("");
	};
	if (script.setup) {
		lines.push(
			"<!-- Setup fill text is persisted. Never store credentials, passwords, tokens, or MFA codes; enter them manually. -->",
			"",
		);
		appendSteps("## Setup", script.setup.steps);
	}
	appendSteps("## Steps", script.steps);
	return lines.join("\n");
}

/** Pull the runnable TourScript out of a plan's first ```json fenced block. */
export function extractScriptFromMarkdown(md: string): unknown {
	const match = md.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!match) throw new Error("no ```json script block found in the plan file");
	return JSON.parse(match[1]);
}
