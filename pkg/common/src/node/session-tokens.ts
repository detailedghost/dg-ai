import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { DgCliError } from "../errors";
import { ensurePrivateDir } from "./fs";
import type { DgPaths } from "./paths";

export function mintToken(): string {
	return randomBytes(32).toString("base64url");
}

export function tokensEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a, "utf8");
	const bufB = Buffer.from(b, "utf8");
	if (bufA.length !== bufB.length) {
		const maxLen = Math.max(bufA.length, bufB.length, 1);
		timingSafeEqual(
			Buffer.concat([bufA, Buffer.alloc(maxLen - bufA.length)]),
			Buffer.concat([bufB, Buffer.alloc(maxLen - bufB.length)]),
		);
		return false;
	}
	return timingSafeEqual(bufA, bufB);
}

function sessionFilePath(paths: DgPaths, sessionId: string): string {
	return `${paths.sessionsDir}/${sessionId}.json`;
}

export type SessionTokenRecord = {
	sessionId: string;
	token: string;
	cwd: string;
	agentIdentity: string;
};

export function writeSessionToken(
	paths: DgPaths,
	sessionId: string,
	record: SessionTokenRecord,
): void {
	ensurePrivateDir(paths.sessionsDir);
	const file = sessionFilePath(paths, sessionId);
	writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
}

export function removeSessionToken(paths: DgPaths, sessionId: string): void {
	rmSync(sessionFilePath(paths, sessionId), { force: true });
}

export function readSessionToken(paths: DgPaths, sessionId: string): string {
	const override = process.env.DG_SESSION_TOKEN;
	if (override !== undefined) return override;
	const raw = readFileSync(sessionFilePath(paths, sessionId), "utf8");
	return (JSON.parse(raw) as { token: string }).token;
}

export function readSessionFiles(sessionsDir: string): SessionTokenRecord[] {
	let names: string[];
	try {
		names = readdirSync(sessionsDir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		try {
			const value = JSON.parse(
				readFileSync(`${sessionsDir}/${name}`, "utf8"),
			) as Partial<SessionTokenRecord>;
			if (
				typeof value.sessionId === "string" &&
				typeof value.token === "string" &&
				typeof value.cwd === "string" &&
				typeof value.agentIdentity === "string"
			) {
				return [value as SessionTokenRecord];
			}
		} catch {
			return [];
		}
		return [];
	});
}

function describeCandidates(records: SessionTokenRecord[]): string {
	if (records.length === 0) return "  (none)";
	return records
		.map((record) => `  ${record.sessionId}  ${record.cwd}`)
		.join("\n");
}

/** The one live session registered from this working directory. */
export function soleSessionForCwd(sessionsDir: string): SessionTokenRecord {
	const records = readSessionFiles(sessionsDir);
	const cwd = realpathSync(process.cwd());
	const matches = records.filter((record) => {
		try {
			return realpathSync(record.cwd) === cwd;
		} catch {
			return false;
		}
	});
	if (matches.length !== 1) {
		throw new DgCliError(
			`cannot resolve a session for cwd ${cwd}: found ${matches.length} matches; pass --session <id>. Live sessions:\n${describeCandidates(records)}`,
		);
	}
	return matches[0];
}
