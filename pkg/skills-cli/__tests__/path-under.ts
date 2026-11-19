import { isAbsolute, relative, sep } from "node:path";

export function isUnder(root: string, path: string | undefined): boolean {
	if (!path) return false;
	const rel = relative(root, path);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
