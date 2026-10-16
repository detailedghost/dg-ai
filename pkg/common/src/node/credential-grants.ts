import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { validateCredentialGrantPrefix } from "../credentials-format";
import { ensurePrivateDir, writeFileAtomic } from "./fs";
import type { DgPaths } from "./paths";

export function credentialGrantTokenPath(
	paths: DgPaths,
	prefix: string,
): string {
	return join(
		paths.grantsDir,
		`${validateCredentialGrantPrefix(prefix)}.token`,
	);
}

/** Replaces the 0600 token file in the 0700 grants directory. */
export function writeCredentialGrantToken(
	paths: DgPaths,
	prefix: string,
	token: string,
): string {
	ensurePrivateDir(paths.grantsDir);
	const path = credentialGrantTokenPath(paths, prefix);
	writeFileAtomic(path, token, 0o600);
	return path;
}

export function readCredentialGrantToken(
	paths: DgPaths,
	prefix: string,
): string {
	return readFileSync(credentialGrantTokenPath(paths, prefix), "utf8").trim();
}

export function removeCredentialGrantToken(
	paths: DgPaths,
	prefix: string,
): void {
	rmSync(credentialGrantTokenPath(paths, prefix), { force: true });
}
