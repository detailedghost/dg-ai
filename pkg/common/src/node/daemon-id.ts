import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "./fs";
import type { DgPaths } from "./dg-paths";
import { mintToken } from "./session-tokens";

export function daemonIdPath(paths: DgPaths): string {
	return join(paths.daemonDir, "daemon.id");
}

function readDaemonId(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	const id = readFileSync(path, "utf8").trim();
	return id.length > 0 ? id : undefined;
}

/** Creates the daemon identity on first start; concurrent starts all adopt the one id that won. */
export function ensureDaemonId(paths: DgPaths): string {
	const path = daemonIdPath(paths);
	const existing = readDaemonId(path);
	if (existing !== undefined) return existing;
	ensurePrivateDir(paths.daemonDir);
	const candidate = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(candidate, mintToken(), { mode: 0o600 });
		try {
			linkSync(candidate, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		rmSync(candidate, { force: true });
	}
	const winner = readDaemonId(path);
	if (winner === undefined) throw new Error("The daemon identity could not be created.");
	return winner;
}
