export const CUSTOM_REACTION_ID =
	/^[a-zA-Z0-9_-]{1,128};0-[a-z]{2,5}-d[0-9]{1,3}-[a-fA-F0-9]{32}$/;

export const isCustomReactionId = (id: string): boolean =>
	CUSTOM_REACTION_ID.test(id);

export function validateReactionIds(
	configured: Record<string, string>,
	listed: string[],
): void {
	const known = new Set(listed);
	for (const [key, id] of Object.entries(configured)) {
		if (isCustomReactionId(id)) continue;
		if (id.includes(";0-cus-")) {
			throw new Error(`${key}: "${id}" is not a valid custom reaction id`);
		}
		if (!known.has(id)) {
			throw new Error(
				`${key}: reaction id "${id}" is not in the Teams reaction catalog`,
			);
		}
	}
}
