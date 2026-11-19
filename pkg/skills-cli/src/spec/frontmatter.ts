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
