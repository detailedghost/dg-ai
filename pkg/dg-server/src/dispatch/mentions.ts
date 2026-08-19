// Mirrors PROTO_IDENTIFIER (proto-format.ts) so a resolvable @name always
// matches what validateProtoIdentifier accepted onto the subagent list.
const MENTION_PATTERN = /@([A-Za-z0-9][A-Za-z0-9_-]{0,127})/g;

/**
 * First @mention in `body` that names a published subagent, or undefined —
 * for no mention, or one that names nobody. An unresolved mention is never a
 * failure; the caller passes the message through as ordinary prose.
 */
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
