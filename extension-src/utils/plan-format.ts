/**
 * Render a tour script as a human-readable, re-runnable plan (Markdown). The
 * narrative is for humans; the fenced ```json block is the machine-runnable
 * source that `dg-browser rerun <plan.md>` extracts. Mirrors the CLI-side
 * plan-format.ts (separate build roots can't share code).
 */

import type { TourScript } from "@/lib/demo-types";

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
