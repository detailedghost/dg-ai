/** Scan synced config files for literal secret values before they land in another tool's config. */

import { existsSync, readFileSync } from "node:fs";

const SECRET_PATTERNS: RegExp[] = [
	/Authorization["']?\s*:\s*["']?Bearer\s+[A-Za-z0-9+/._-]{40,}/,
	/"[A-Za-z0-9_]*(API[_-]?KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*"\s*:\s*"[^$"][^"]{8,}/,
	/ctx7sk-[A-Za-z0-9_-]{8,}/,
	/ghp_[A-Za-z0-9]{36}/,
	/github_pat_[A-Za-z0-9_]{82}/,
	/sk-[A-Za-z0-9]{32,}/,
	/xoxb-\d+-\d+-[A-Za-z0-9]+/,
	/AKIA[0-9A-Z]{16}/,
	/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	/FAKE_TOKEN_[0-9a-f]{40}/,
];

export interface SecretWallHit {
	path: string;
}

/** Scan each existing path for a secret-shaped literal; returns the offending paths, if any. */
export function checkSecretWall(paths: readonly string[]): SecretWallHit[] {
	const hits: SecretWallHit[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) hits.push({ path });
	}
	return hits;
}
