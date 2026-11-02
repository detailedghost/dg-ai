const AI_NAME = /claude|codex|grok|copilot|openai|gemini|anthropic|gpt/i;
const AI_BOT = /noreply@x\.ai|cursoragent@cursor\.com|devin-ai-integration\[bot\]/i;
const COAUTHOR = /^co-authored-by:\s*(.*)$/i;
const TRAILER = /^[A-Za-z][\w-]*:\s/;
const isBlank = (line: string) => line.trim() === "";

export const isAiCoauthor = (identity: string): boolean =>
	AI_NAME.test(identity) || AI_BOT.test(identity);

const isAiTrailer = (line: string): boolean => {
	const identity = COAUTHOR.exec(line)?.[1];
	return identity !== undefined && isAiCoauthor(identity);
};

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
	const block = content.slice(start);
	if (start === 0 || !block.every((line) => TRAILER.test(line))) return message;
	const kept = block.filter((line) => !isAiTrailer(line));
	if (kept.length === block.length) return message;
	const before = content.slice(0, start);
	if (kept.length === 0) while (before.length > 0 && isBlank(before.at(-1) as string)) before.pop();
	const tail = end < lines.length ? `\n${lines.slice(end).join("\n")}` : "";
	return `${[...before, ...kept].join("\n")}${tail}`;
}
