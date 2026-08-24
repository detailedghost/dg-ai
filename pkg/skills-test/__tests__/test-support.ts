import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

export function readRepoFile(...parts: string[]): string {
	return readFileSync(join(REPO_ROOT, ...parts), "utf8");
}
