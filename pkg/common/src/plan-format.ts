/**
 * Tour-plan format + validation. A plan is a human-authored Markdown file: YAML
 * frontmatter (title / startUrl / mode) plus a "## Steps" list — one line per step,
 * with each step's timing shown inline. The CLI reads that human form and (re)generates
 * the machine-runnable TourScript into the "## Script" fenced json block.
 *
 * This module is pure and dependency-free — it is bundled into the browser extension
 * too. The markdown *reader* (which pulls in `marked`) lives CLI-side in
 * pkg/skills-cli/src/utils/plan-parse.ts.
 */

import type { StepAction, StepAdvance, TourScript } from "./types";

/** Structural validation — the extension trusts what the CLI encodes. */
export function validate(script: unknown): TourScript {
	if (!script || typeof script !== "object")
		throw new Error("script must be a JSON object");
	const s = script as Record<string, unknown>;
	if (typeof s.startUrl !== "string" || !/^https?:\/\//.test(s.startUrl))
		throw new Error("script.startUrl must be an http(s) URL");
	if (!Array.isArray(s.steps) || s.steps.length === 0)
		throw new Error("script.steps must be a non-empty array");
	if (s.mode !== undefined && s.mode !== "walkthrough" && s.mode !== "video")
		throw new Error("script.mode must be 'walkthrough' or 'video'");
	s.steps.forEach((step: Record<string, unknown>, i) => {
		if (!step || typeof step !== "object" || typeof step.body !== "string")
			throw new Error(`step ${i} must be an object with a string 'body'`);
		if (step.selector !== undefined && typeof step.selector !== "string")
			throw new Error(`step ${i}: 'selector' must be a string`);
		if (step.title !== undefined && typeof step.title !== "string")
			throw new Error(`step ${i}: 'title' must be a string`);
		if (
			step.advance !== undefined &&
			step.advance !== "next" &&
			step.advance !== "click" &&
			typeof step.advance !== "number"
		)
			throw new Error(
				`step ${i}: 'advance' must be 'next', 'click', or a number`,
			);
		if (
			step.navigate !== undefined &&
			(typeof step.navigate !== "string" || !/^https?:\/\//.test(step.navigate))
		)
			throw new Error(`step ${i}: 'navigate' must be an http(s) URL`);
		if (step.action !== undefined) {
			const a = step.action as Record<string, unknown>;
			if (a?.do === "fill") {
				if (typeof a.value !== "string")
					throw new Error(`step ${i}: fill action needs a string 'value'`);
			} else if (a?.do !== "click") {
				throw new Error(`step ${i}: 'action.do' must be 'click' or 'fill'`);
			}
		}
	});
	return script as TourScript;
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
		"---",
	];
	const lines = [
		...fm,
		"",
		"<!-- Play/record: dg-browser demo <this-file>  ·  Replay: dg-browser rerun <this-file> -->",
		"<!-- Edit the steps below; the CLI derives the runnable script from them. -->",
		"",
		"## Steps",
		"",
	];
	script.steps.forEach((step, i) => {
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
	return lines.join("\n");
}

/** Pull the runnable TourScript out of a plan's first ```json fenced block. */
export function extractScriptFromMarkdown(md: string): unknown {
	const match = md.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!match) throw new Error("no ```json script block found in the plan file");
	return JSON.parse(match[1]);
}
