const DROPPED_BLOCK = /<(head|style|script)\b[^>]*>[\s\S]*?<\/\1>/gi;
const LIST_ITEM_OPEN = /<li\b[^>]*>/gi;
const NEWLINE_TAG = /<\/(p|div|li|tr|h[1-6])>|<br\s*\/?>/gi;
const ANY_TAG = /<[^>]+>/g;
const NUMERIC_ENTITY = /&#(\d+);/g;
const HORIZONTAL_WHITESPACE = /[ \t]+/g;
const EXCESS_BLANK_LINES = /\n{3,}/g;

function decodeEntities(input: string): string {
	return input
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/gi, " ")
		.replace(NUMERIC_ENTITY, (_match, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&amp;/gi, "&");
}

/** Converts mail HTML to plain text with a handful of regexes, never a full HTML parser. */
export function htmlToText(html: string): string {
	let text = html.replace(DROPPED_BLOCK, "");
	text = text.replace(LIST_ITEM_OPEN, "\n- ");
	text = text.replace(NEWLINE_TAG, "\n");
	text = text.replace(ANY_TAG, "");
	text = decodeEntities(text);
	text = text.replace(HORIZONTAL_WHITESPACE, " ");
	text = text.replace(EXCESS_BLANK_LINES, "\n\n");
	return text.trim();
}
