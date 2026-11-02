const AI_NAME = /\b(?:claude|codex|grok|copilot|openai|gemini|anthropic|gpt|chatgpt)\b/i;
const AI_EMAIL =
	/^(?:noreply@(?:anthropic\.com|openai\.com|x\.ai|google\.com)|cursoragent@cursor\.com)$|\[bot\]@/i;
const NOREPLY_EMAIL = /no-?reply/i;
const IDENTITY = /^(.*?)\s*<([^>]*)>\s*$/;
const COAUTHOR = /^co-authored-by:\s*([^\n]*)$/i;
const TRAILER = /^(?:[A-Za-z][\w-]*|BREAKING CHANGE):/;
const CONTINUATION = /^\s+\S/;
const TRAILING_CR = /\r$/;
const isBlank = (line: string) => line.trim() === "";

/** A known AI or bot address, or an AI name paired with a noreply address or no address. */
export function isAiCoauthor(identity: string): boolean {
	const parts = IDENTITY.exec(identity.trim());
	const name = parts ? (parts[1] as string) : identity;
	const email = parts ? (parts[2] as string).trim() : "";
	if (AI_EMAIL.test(email)) return true;
	return AI_NAME.test(name) && (email === "" || NOREPLY_EMAIL.test(email));
}

const isAiTrailer = (line: string): boolean => {
	const identity = COAUTHOR.exec(line)?.[1];
	return identity !== undefined && isAiCoauthor(identity);
};

function trailerEntries(block: string[], commentChar: string): string[][] | undefined {
	const entries: string[][] = [];
	for (const line of block) {
		if (line.startsWith(commentChar)) {
			if (entries.length > 0) entries.at(-1)?.push(line);
			else entries.push([line]);
		} else if (TRAILER.test(line)) entries.push([line]);
		else if (CONTINUATION.test(line) && entries.length > 0)
			entries.at(-1)?.push(line);
		else return undefined;
	}
	return entries;
}

/** Removes AI Co-Authored-By trailers from the final trailer block; subject, body and git comment lines stay. */
export function stripAiCoauthors(message: string, commentChar = "#"): string {
	const lines = message.split("\n");
	const scissors = `${commentChar} ${"-".repeat(24)} >8 ${"-".repeat(24)}`;
	const cut = lines.findIndex((line) => line.replace(TRAILING_CR, "") === scissors);
	let end = cut === -1 ? lines.length : cut;
	while (end > 0) {
		const line = lines[end - 1] as string;
		if (!isBlank(line) && !line.startsWith(commentChar)) break;
		end--;
	}
	const content = lines.slice(0, end);
	const start = content.findLastIndex(isBlank) + 1;
	const entries = start === 0 ? undefined : trailerEntries(content.slice(start), commentChar);
	if (!entries) return message;
	const isComment = (line: string) => line.startsWith(commentChar);
	const removed = entries.filter((entry) =>
		isAiTrailer(
			entry
				.filter((line) => !isComment(line))
				.map((line) => line.replace(TRAILING_CR, ""))
				.join(" "),
		),
	);
	if (removed.length === 0) return message;
	const kept = entries.flatMap((entry) =>
		removed.includes(entry) ? entry.filter(isComment) : entry,
	);
	const before = content.slice(0, start);
	if (kept.length === 0) while (before.length > 0 && isBlank(before.at(-1) as string)) before.pop();
	const tail = end < lines.length ? `\n${lines.slice(end).join("\n")}` : "";
	return `${[...before, ...kept].join("\n")}${tail}`;
}
