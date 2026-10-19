/** Whether a path points into Bun's virtual compiled-executable filesystem. */
export function isVirtualBunPath(value: string | undefined): boolean {
	return /(?:^|\/)(?:\$bunfs|~BUN)(?:\/|$)/i.test(
		value?.replaceAll("\\", "/") ?? "",
	);
}
