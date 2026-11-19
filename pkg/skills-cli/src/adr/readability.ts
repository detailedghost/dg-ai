const FENCE = /^\s*(`{3,}|~{3,})/;
export const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const HEADER_LINE = /^\s*(Status|Date|Topic|Level):/;
const TABLE_ROW = /^\s*\|/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TOKEN = /[A-Za-z]+(?:['’][A-Za-z]+)*|\d+(?:[.,]\d+)*/g;
const SENTENCE_END = /[.!?]+(?:\s+|$)/;
const GROUPS = /[aeiouy]+/g;

export interface ScannedLine {
	line: string;
	kind: "text" | "open" | "body" | "close";
}

export function scanFences(text: string): ScannedLine[] {
	let open: string | null = null;
	return text.split(/\r?\n/).map((line) => {
		const run = line.match(FENCE)?.[1];
		if (open === null) {
			if (run === undefined) return { line, kind: "text" };
			open = run;
			return { line, kind: "open" };
		}
		if (run !== undefined && run[0] === open[0] && run.length >= open.length && line.trim() === run) {
			open = null;
			return { line, kind: "close" };
		}
		return { line, kind: "body" };
	});
}

export function outsideFences(text: string): string[] {
	return scanFences(text)
		.filter((entry) => entry.kind === "text")
		.map((entry) => entry.line);
}

const TRAILING_PUNCTUATION = ".,;:!?)";

function looksLikePath(core: string): boolean {
	if (!core.includes("/")) return false;
	return core.includes(".") || /^[~/]/.test(core) || core.split("/").length > 2;
}

function pathToSpace(token: string): string {
	let end = token.length;
	while (end > 0 && TRAILING_PUNCTUATION.includes(token[end - 1] ?? "")) end -= 1;
	return looksLikePath(token.slice(0, end)) ? ` ${token.slice(end)}` : token;
}

function proseOf(line: string): string {
	return line
		.replace(LIST_MARKER, "")
		.replace(/^\s*>\s?/, "")
		.replace(/`[^`]*`/g, " ")
		.replace(/!?\[([^\][]{0,500})\]\([^)]{0,500}\)/g, "$1")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\S+/g, pathToSpace);
}

function syllablesOf(token: string): number {
	if (/^\d/.test(token)) return 1;
	const word = token.toLowerCase().replace(/['’]/g, "");
	let count = word.match(GROUPS)?.length ?? 0;
	if (count > 1) {
		const silent = (word.endsWith("e") && !/[^aeiouy]le$/.test(word)) || (word.endsWith("es") && !/(?:s|x|z|ch|sh|c|g)es$/.test(word)) || (word.endsWith("ed") && !/[td]ed$/.test(word));
		if (silent) count -= 1;
	}
	return Math.max(1, count);
}

export function gradeOf(text: string): number {
	let words = 0;
	let sentences = 0;
	let syllables = 0;
	for (const line of outsideFences(text)) {
		if (HEADING.test(line) || HEADER_LINE.test(line) || TABLE_ROW.test(line)) continue;
		for (const segment of proseOf(line).split(SENTENCE_END)) {
			const tokens = segment.match(TOKEN) ?? [];
			if (tokens.length === 0) continue;
			sentences += 1;
			words += tokens.length;
			syllables += tokens.reduce((sum, token) => sum + syllablesOf(token), 0);
		}
	}
	if (words === 0) return 0;
	return 0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59;
}
