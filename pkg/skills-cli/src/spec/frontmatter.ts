import { escapeRegExp } from "@dg/common";
import { parseDocument } from "yaml";
import { joinRecords, records, stripNewlines } from "./shared";

export interface DocumentSplit {
	front: string;
	body: string;
}

/** Split on a first-line `---` fence; an unclosed fence makes the rest frontmatter. */
export function splitDocument(text: string): DocumentSplit {
	const lines = text.split("\n");
	if (lines[0] !== "---") return { front: "", body: text };
	const phantom = lines[lines.length - 1] === "" ? 1 : 0;
	const close = lines.indexOf("---", 1);
	if (close < 0)
		return {
			front: lines.slice(1, lines.length - phantom).join("\n"),
			body: "",
		};
	return {
		front: lines.slice(1, close).join("\n"),
		body: lines.slice(close + 1).join("\n"),
	};
}

export function frontmatterOf(text: string): string {
	return stripNewlines(splitDocument(text).front);
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

/** Set `permissions.<key>` in a document, creating the fence or block when absent. */
export function withPermission(
	text: string,
	key: string,
	value: string,
): string {
	if (text.split("\n")[0] !== "---")
		return `---\npermissions:\n  ${key}: ${value}\n---\n${text}`;
	const keyLine = new RegExp(`^\\s+${escapeRegExp(key)}:`);
	const replaceKey = new RegExp(`${escapeRegExp(key)}:\\s*.*`);
	const out: string[] = [];
	let inFront = false;
	let sawBlock = false;
	let inBlock = false;
	let sawKey = false;
	records(text).forEach((line, index) => {
		if (index === 0) {
			inFront = true;
			out.push(line);
			return;
		}
		if (inFront && line === "---") {
			if (!sawBlock) out.push("permissions:", `  ${key}: ${value}`);
			else if (inBlock && !sawKey) out.push(`  ${key}: ${value}`);
			inFront = false;
			out.push(line);
			return;
		}
		if (inFront && /^permissions:\s*(\{\s*\})?\s*$/.test(line)) {
			sawBlock = true;
			inBlock = true;
			out.push("permissions:");
			return;
		}
		if (inFront && inBlock && keyLine.test(line)) {
			sawKey = true;
			out.push(line.replace(replaceKey, () => `${key}: ${value}`));
			return;
		}
		if (inFront && inBlock && /^\S/.test(line)) {
			if (!sawKey) {
				out.push(`  ${key}: ${value}`);
				sawKey = true;
			}
			inBlock = false;
		}
		out.push(line);
	});
	return joinRecords(out);
}
