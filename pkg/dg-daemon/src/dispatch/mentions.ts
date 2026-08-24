const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,127})/g;

export function resolveSubagentMention(
	body: string,
	subagentNames: readonly string[],
): string | undefined {
	if (subagentNames.length === 0) return undefined;
	const known = new Set(subagentNames);
	for (const match of body.matchAll(MENTION_PATTERN)) {
		if (known.has(match[1])) return match[1];
	}
	return undefined;
}
