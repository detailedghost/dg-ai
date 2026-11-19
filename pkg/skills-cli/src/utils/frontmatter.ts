import { escapeRegExp, isRecord } from "@dg/common";
import { parseDocument } from "yaml";

/** Split text into awk records: no phantom record after a final newline. */
export function records(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export interface DocumentSplit {
	front: string;
	body: string;
}

function stripCr(line: string): string {
	return line.replace(/\r$/, "");
}

/** Split on a first-line `---` fence; an unclosed fence makes the rest frontmatter. */
export function splitDocument(text: string): DocumentSplit {
	const lines = text.split("\n");
	if (lines[0]?.trimEnd() !== "---") return { front: "", body: text };
	const phantom = lines[lines.length - 1] === "" ? 1 : 0;
	const close = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
	if (close < 0)
		return {
			front: lines.slice(1, lines.length - phantom).map(stripCr).join("\n"),
			body: "",
		};
	return {
		front: lines.slice(1, close).map(stripCr).join("\n"),
		body: lines.slice(close + 1).join("\n"),
	};
}

export type YamlResult =
	| { ok: true; value: unknown }
	| { ok: false; error: string };

export function parseYaml(text: string): YamlResult {
	const doc = parseDocument(text, { uniqueKeys: false });
	const [first] = doc.errors;
	return first === undefined
		? { ok: true, value: doc.toJS() }
		: { ok: false, error: first.message };
}

/** Parsed front matter as a record; empty when absent, malformed, or not a mapping. */
export function frontOf(text: string): Record<string, unknown> {
	const parsed = parseYaml(splitDocument(text).front);
	return parsed.ok && isRecord(parsed.value) ? parsed.value : {};
}

const QUOTES = /^["']|["']$/g;

/** Value of a top-level `key:` line, quotes trimmed; empty when absent. */
export function scalarField(front: string, key: string): string {
	const prefix = new RegExp(`^${escapeRegExp(key)}:`);
	for (const line of records(front)) {
		if (prefix.test(line))
			return line.replace(/^[^:]*:\s*/, "").replace(QUOTES, "");
	}
	return "";
}

/** Value of `parent:` then an indented `key:` line, quotes trimmed; empty when absent. */
export function nestedScalar(
	front: string,
	parent: string,
	key: string,
): string {
	const head = new RegExp(`^${escapeRegExp(parent)}:`);
	const child = new RegExp(`^\\s+${escapeRegExp(key)}:`);
	let inParent = false;
	for (const line of records(front)) {
		if (head.test(line)) {
			inParent = true;
			continue;
		}
		if (inParent && /^\S/.test(line)) inParent = false;
		if (inParent && child.test(line))
			return line.replace(/^\s+[^:]+:\s*/, "").replace(QUOTES, "");
	}
	return "";
}
