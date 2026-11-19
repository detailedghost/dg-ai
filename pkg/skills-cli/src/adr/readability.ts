const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const HEADER_LINE = /^\s*(Status|Date|Topic|Level):/;
const TABLE_ROW = /^\s*\|/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TOKEN = /[A-Za-z]+(?:['’][A-Za-z]+)*|\d+(?:[.,]\d+)*/g;
const SENTENCE_END = /[.!?]+(?:\s+|$)/;
const GROUPS = /[aeiouy]+/g;

export function outsideFences(text: string): string[] {
	let inFence = false;
	return text.split("\n").filter((line) => {
		if (FENCE.test(line)) {
			inFence = !inFence;
			return false;
		}
		return !inFence;
	});
}

const TRAILING_PUNCTUATION = ".,;:!?)";

function pathToSpace(token: string): string {
	let end = token.length;
	while (end > 0 && TRAILING_PUNCTUATION.includes(token[end - 1] ?? "")) end -= 1;
	return token.slice(0, end).includes("/") ? ` ${token.slice(end)}` : token;
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
