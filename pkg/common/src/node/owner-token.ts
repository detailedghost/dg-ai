import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { noteSecret } from "../redact";
import { ensurePrivateDir, writeFileAtomic } from "./fs";
import type { DgPaths } from "./paths";
import { mintToken } from "./session-tokens";

export function ownerTokenPath(paths: DgPaths): string {
	return join(paths.daemonDir, "owner.token");
}

/** Creates the 0600 owner credential on first start and reuses it after a restart. */
export function ensureOwnerToken(paths: DgPaths): string {
	const existing = readOwnerToken(paths);
	if (existing !== undefined) return existing;
	ensurePrivateDir(paths.daemonDir);
	const token = mintToken();
	const path = ownerTokenPath(paths);
	writeFileAtomic(path, token, 0o600);
	chmodSync(path, 0o600);
	return token;
}

export function readOwnerToken(paths: DgPaths): string | undefined {
	const path = ownerTokenPath(paths);
	if (!existsSync(path)) return undefined;
	try {
		const token = readFileSync(path, "utf8").trim();
		if (token.length === 0) return undefined;
		noteSecret(token);
		return token;
	} catch {
		return undefined;
	}
}
