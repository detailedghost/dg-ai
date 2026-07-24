/** Stable filesystem-safe slug used by CLI and extension artifacts. */
export function slugify(value: string, fallback = "demo"): string {
	return value.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || fallback;
}
