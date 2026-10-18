/**
 * Branches a force-push must not update. `main` and `master` are always
 * protected. The repository default is protected too, including when it
 * has another name.
 */
export function protectedPushReason(
	branch: string,
	defaultBranch?: string,
): string | undefined {
	const names = new Set<string>(["main", "master"]);
	if (defaultBranch) names.add(defaultBranch);
	if (!names.has(branch)) return undefined;
	return `refusing to force-push protected branch '${branch}'`;
}
