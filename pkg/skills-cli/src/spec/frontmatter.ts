import { escapeRegExp } from "@dg/common";
import { nestedScalar, parseYaml, scalarField, splitDocument } from "../utils/frontmatter";
import { joinRecords, records, stripNewlines } from "./shared";

export type { DocumentSplit, YamlResult } from "../utils/frontmatter";
export { nestedScalar, parseYaml, scalarField, splitDocument };

export function frontmatterOf(text: string): string {
	return stripNewlines(splitDocument(text).front);
}

/** Set `permissions.<key>` in a document, creating the fence or block when absent. */
export function withPermission(
	text: string,
	key: string,
	value: string,
): string {
	const cr = text.includes("\r\n") ? "\r" : "";
	if (text.split("\n")[0]?.replace(/\r$/, "") !== "---")
		return `---${cr}\npermissions:${cr}\n  ${key}: ${value}${cr}\n---${cr}\n${text}`;
	const keyLine = new RegExp(`^\\s+${escapeRegExp(key)}:`);
	const replaceKey = new RegExp(`${escapeRegExp(key)}:[ \\t]*.*`);
	const out: string[] = [];
	let inFront = false;
	let sawBlock = false;
	let inBlock = false;
	let sawKey = false;
	records(text).forEach((raw, index) => {
		const line = raw.replace(/\r$/, "");
		if (index === 0) {
			inFront = true;
			out.push(raw);
			return;
		}
		if (inFront && line === "---") {
			if (!sawBlock) out.push(`permissions:${cr}`, `  ${key}: ${value}${cr}`);
			else if (inBlock && !sawKey) out.push(`  ${key}: ${value}${cr}`);
			inFront = false;
			out.push(raw);
			return;
		}
		if (inFront && /^permissions:\s*(\{\s*\})?\s*$/.test(line)) {
			sawBlock = true;
			inBlock = true;
			out.push(`permissions:${cr}`);
			return;
		}
		if (inFront && inBlock && keyLine.test(line)) {
			sawKey = true;
			out.push(raw.replace(replaceKey, () => `${key}: ${value}`));
			return;
		}
		if (inFront && inBlock && /^\S/.test(line)) {
			if (!sawKey) {
				out.push(`  ${key}: ${value}${cr}`);
				sawKey = true;
			}
			inBlock = false;
		}
		out.push(raw);
	});
	return joinRecords(out);
}
