import pairs from "../data/spelling-pairs.txt" with { type: "text" };
import type { HookHandler, HookInput } from "../types";

type Locale = "en-US" | "en-GB";
type Table = Map<string, string>;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

const MAX_SCAN_CHARS = 512 * 1024;
const tables = new Map<Locale, Table>();

export function tableFor(locale: Locale): Table {
	const cached = tables.get(locale);
	if (cached) return cached;
	const table: Table = new Map();
	for (const line of pairs.split("\n")) {
		const [british, american, usOnly] = line.trim().split(/\s+/);
		if (!british || !american) continue;
		if (locale === "en-US") table.set(british, american);
		else if (!usOnly) table.set(american, british);
	}
	tables.set(locale, table);
	return table;
}

export function tokens(text: string): string[] {
	return text.split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean);
}

export function findings(text: string, table: Table, max: number): string[] {
	const out = new Set<string>();
	for (const [i, line] of text.split("\n").entries())
		for (const token of tokens(line)) {
			const fix = table.get(token.toLowerCase());
			if (fix) out.add(`${i + 1}: ${token} -> ${fix}`);
			if (out.size >= max) return [...out];
		}
	return [...out];
}

function writtenText(input: HookInput): string {
	const toolInput = input.tool_input ?? {};
	if (input.tool_name === "Write") return String(toolInput["content"] ?? "");
	if (input.tool_name === "MultiEdit") {
		const edits = toolInput["edits"];
		if (!Array.isArray(edits)) return "";
		return edits
			.map((edit: { new_string?: unknown }) => String(edit?.new_string ?? ""))
			.join("\n");
	}
	return String(toolInput["new_string"] ?? "");
}

const handler: HookHandler = async (input, ctx) => {
	if (!EDIT_TOOLS.has(input.tool_name ?? "")) return { exitCode: 0 };
	if (ctx.bypassed("comment-disabled")) return { exitCode: 0 };
	const text = writtenText(input).slice(0, MAX_SCAN_CHARS);
	if (!text) return { exitCode: 0 };
	const locale = ctx.setting("spelling", "locale") as Locale;
	const found = findings(
		text,
		tableFor(locale),
		ctx.number("HOOK_SPELLING_MAX_FINDINGS", 8),
	);
	if (found.length === 0) return { exitCode: 0 };
	const file = String(input.tool_input?.["file_path"] ?? "");
	return {
		exitCode: 2,
		stderr: `spelling: write ${locale} in ${file}\n${found.join("\n")}\nfix: use the ${locale} spelling in code, identifiers, tests, comments and docs.\n`,
	};
};

export default handler;
