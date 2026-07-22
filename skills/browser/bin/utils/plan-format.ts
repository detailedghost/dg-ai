/**
 * Tour-plan format + validation, shared by `demo` and `rerun`. A plan is a
 * human-readable Markdown file whose fenced ```json block is the machine-runnable
 * TourScript — `rerun` extracts that block, `demo` writes one out. The Markdown
 * render mirrors extension-src/lib/plan-format.ts (separate build roots).
 */

export type TourStep = {
	selector?: string;
	title?: string;
	body: string;
	advance?: "next" | "click" | number;
	navigate?: string;
};
export type TourScript = {
	title?: string;
	startUrl: string;
	steps: TourStep[];
	mode?: "walkthrough" | "video";
};

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
	});
	return script as TourScript;
}

/** Render a validated script as a readable, re-runnable plan (Markdown). */
export function toPlanMarkdown(script: TourScript): string {
	const title = script.title ?? "demo";
	const lines = [
		`# Demo plan: ${title}`,
		"",
		"<!-- Re-run this demo: dg-browser rerun <this-file> -->",
		"",
		`- **Start URL:** ${script.startUrl}`,
		`- **Mode:** ${script.mode ?? "walkthrough"}`,
		`- **Steps:** ${script.steps.length}`,
		"",
		"## Steps",
		"",
	];
	script.steps.forEach((step, i) => {
		const sel = step.selector ? ` \`${step.selector}\`` : " (centered)";
		lines.push(`${i + 1}. **${step.title ?? "Step"}**${sel} — ${step.body}`);
	});
	lines.push(
		"",
		"## Script",
		"",
		"```json",
		JSON.stringify(script, null, 2),
		"```",
		"",
	);
	return lines.join("\n");
}

/** Pull the runnable TourScript out of a plan's first ```json fenced block. */
export function extractScriptFromMarkdown(md: string): unknown {
	const match = md.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!match) throw new Error("no ```json script block found in the plan file");
	return JSON.parse(match[1]);
}
