/** Shell-style glob (only `*` and `?`) → anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

export function urlMatches(url: string, patterns: string[]): boolean {
	return patterns.some((p) => globToRegExp(p).test(url));
}
