/**
 * Reader for the human-authored plan format (frontmatter + "## Steps" list). Uses
 * `marked` to tokenize the document so the ordered list is located structurally
 * rather than by hand-rolled line slicing; each item's inline shape
 * (`**title**` `` `selector` `` → nav — body `timing`) is then pulled apart.
 * CLI-only — kept out of @dg/common so the extension bundle stays lib-free.
 */

import {
	extractScriptFromMarkdown,
	parseAction,
	parseAdvance,
	type StepAdvance,
	type TourScript,
	type TourStep,
} from "@dg/common";
import { marked, type Tokens } from "marked";

/** Split the leading `---` YAML frontmatter into a scalar key→value map + the body. */
function splitFrontmatter(md: string): {
	data: Record<string, string>;
	body: string;
} {
	const m = md.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
	if (!m) return { data: {}, body: md };
	const data: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const kv = line.match(/^\s*([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/);
		if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
	}
	return { data, body: md.slice(m[0].length) };
}

/** Turn one Steps list item's inline text into a TourStep. */
function parseStepItem(text: string): TourStep {
	const titleMatch = text.match(/^\*\*(.*?)\*\*\s*/);
	const title = titleMatch?.[1].trim();
	const rest = titleMatch ? text.slice(titleMatch[0].length) : text;

	// Split meta (selector/navigate) from body on the first em-dash, trimming so
	// spaces `marked` may collapse don't matter. Any em-dash inside the body is later.
	const dash = rest.indexOf("—");
	const meta = dash >= 0 ? rest.slice(0, dash) : "";
	let body = (dash >= 0 ? rest.slice(dash + 1) : rest).trim();

	const selector = meta.match(/`([^`]+)`/)?.[1];
	const navigate = meta.match(/→\s*(\S+)/)?.[1];
	const action = parseAction(meta);

	// A trailing code span is the timing token — but only if it parses as one, so an
	// inline `code` span ending the prose stays in the body.
	let advance: StepAdvance | undefined;
	const tail = body.match(/`([^`]+)`\s*$/);
	if (tail) {
		const parsed = parseAdvance(tail[1]);
		if (parsed !== undefined) {
			advance = parsed;
			body = body.slice(0, tail.index).trim();
		}
	}

	const step: TourStep = { body };
	if (title) step.title = title;
	if (selector) step.selector = selector;
	if (navigate) step.navigate = navigate;
	if (action) step.action = action;
	if (advance !== undefined) step.advance = advance;
	return step;
}

/**
 * Build a TourScript from a plan's human form. Falls back to the embedded ```json
 * block for plans that predate the human format or carry no parseable steps.
 */
export function parsePlanMarkdown(md: string): unknown {
	const { data, body } = splitFrontmatter(md);
	const list = marked
		.lexer(body)
		.find((t): t is Tokens.List => t.type === "list");
	const steps = (list?.items ?? []).map((it) => parseStepItem(it.text));

	if (!data.startUrl || steps.length === 0)
		return extractScriptFromMarkdown(md);
	const script: TourScript = { startUrl: data.startUrl, steps };
	if (data.title) script.title = data.title;
	if (data.mode === "walkthrough" || data.mode === "video")
		script.mode = data.mode;
	return script;
}
