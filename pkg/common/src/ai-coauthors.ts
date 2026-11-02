const AI_NAME = /claude|codex|grok|copilot|openai|gemini|anthropic|gpt/i;
const AI_BOT = /noreply@x\.ai|cursoragent@cursor\.com|devin-ai-integration\[bot\]/i;
const COAUTHOR = /^co-authored-by:\s*(.*)$/i;
const TRAILER = /^[A-Za-z][\w-]*:\s/;
const CONTINUATION = /^\s+\S/;
const isBlank = (line: string) => line.trim() === "";

export const isAiCoauthor = (identity: string): boolean =>
	AI_NAME.test(identity) || AI_BOT.test(identity);

const isAiTrailer = (line: string): boolean => {
	const identity = COAUTHOR.exec(line)?.[1];
	return identity !== undefined && isAiCoauthor(identity);
};

function trailerEntries(block: string[]): string[][] | undefined {
	const entries: string[][] = [];
	for (const line of block) {
		if (TRAILER.test(line)) entries.push([line]);
		else if (CONTINUATION.test(line) && entries.length > 0)
			entries.at(-1)?.push(line);
		else return undefined;
	}
	return entries;
}

/** Removes AI Co-Authored-By trailers from the final trailer block; subject, body and git comment lines stay. */
export function stripAiCoauthors(message: string): string {
	const lines = message.split("\n");
	let end = lines.length;
	while (end > 0) {
		const line = lines[end - 1] as string;
		if (!isBlank(line) && !line.startsWith("#")) break;
		end--;
	}
	const content = lines.slice(0, end);
	const start = content.findLastIndex(isBlank) + 1;
	const entries = start === 0 ? undefined : trailerEntries(content.slice(start));
	if (!entries) return message;
	const keptEntries = entries.filter((entry) => !isAiTrailer(entry.join(" ")));
	if (keptEntries.length === entries.length) return message;
	const kept = keptEntries.flat();
	const before = content.slice(0, start);
	if (kept.length === 0) while (before.length > 0 && isBlank(before.at(-1) as string)) before.pop();
	const tail = end < lines.length ? `\n${lines.slice(end).join("\n")}` : "";
	return `${[...before, ...kept].join("\n")}${tail}`;
}
