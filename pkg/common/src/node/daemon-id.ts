import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, writeFileAtomic } from "./fs";
import type { DgPaths } from "./dg-paths";
import { mintToken } from "./session-tokens";

export function daemonIdPath(paths: DgPaths): string {
	return join(paths.daemonDir, "daemon.id");
}

/** Creates the daemon identity on first start and reuses it after every restart. */
export function ensureDaemonId(paths: DgPaths): string {
	const path = daemonIdPath(paths);
	const existing = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
	if (existing.length > 0) return existing;
	ensurePrivateDir(paths.daemonDir);
	const id = mintToken();
	writeFileAtomic(path, id, 0o600);
	return id;
}
