import { homedir } from "node:os";
import path from "node:path";

export function profilesRoot(): string {
	const cache = process.env["XDG_CACHE_HOME"] ?? path.join(homedir(), ".cache");
	return path.join(cache, "playwright-cli", "profiles");
}

export const defaultProfileDir = (name: string): string =>
	path.join(profilesRoot(), name);
