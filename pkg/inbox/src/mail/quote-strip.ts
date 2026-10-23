export type StrippedQuotedHistory = {
	text: string;
	removed: boolean;
};

const WROTE_LINE = /^On .{3,200} wrote:\s*$/;
const ORIGINAL_MESSAGE_LINE = /^-{2,}\s*Original Message\s*-{2,}$/;
const UNDERSCORE_LINE = /^_{10,}$/;
const FROM_LINE = /^From: .+$/;
const HEADER_LINE = /^(Sent|To|Date): /;
const QUOTE_LINE = /^\s*>/;
const WRAP_JOIN_LINES = 2;
const HEADER_LOOKAHEAD_LINES = 3;

function matchesWroteLine(lines: string[], index: number): boolean {
	for (let join = 0; join <= WRAP_JOIN_LINES && index + join < lines.length; join++) {
		const candidate = lines.slice(index, index + join + 1).join(" ").trim();
		if (WROTE_LINE.test(candidate)) return true;
	}
	return false;
}

function hasHeaderLineWithin(lines: string[], index: number, within: number): boolean {
	for (let j = index + 1; j <= index + within && j < lines.length; j++) {
		if (HEADER_LINE.test(lines[j])) return true;
	}
	return false;
}

function findQuoteMarker(lines: string[]): number {
	for (let i = 0; i < lines.length; i++) {
		if (matchesWroteLine(lines, i)) return i;
		if (ORIGINAL_MESSAGE_LINE.test(lines[i])) return i;
		if (UNDERSCORE_LINE.test(lines[i])) return i;
		if (FROM_LINE.test(lines[i]) && hasHeaderLineWithin(lines, i, HEADER_LOOKAHEAD_LINES))
			return i;
	}
	return -1;
}

function findTrailingQuoteBlock(lines: string[]): number {
	let i = lines.length;
	while (i > 0 && (lines[i - 1].trim() === "" || QUOTE_LINE.test(lines[i - 1]))) i--;
	return lines.slice(i).some((line) => QUOTE_LINE.test(line)) ? i : -1;
}

/** Cuts a reply at the first quoted-history marker, then drops any trailing `>` block the marker missed. */
export function stripQuotedHistory(text: string): StrippedQuotedHistory {
	let lines = text.split("\n");
	let removed = false;

	const markerIndex = findQuoteMarker(lines);
	if (markerIndex !== -1) {
		lines = lines.slice(0, markerIndex);
		removed = true;
	}

	const trailingQuoteIndex = findTrailingQuoteBlock(lines);
	if (trailingQuoteIndex !== -1) {
		lines = lines.slice(0, trailingQuoteIndex);
		removed = true;
	}

	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

	return { text: lines.join("\n"), removed };
}
