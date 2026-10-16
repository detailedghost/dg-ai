import { Database } from "bun:sqlite";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { DgCliError } from "../errors";
import { noteSecret } from "../redact";
import { ensurePrivateDir } from "./fs";
import type { DgPaths } from "./paths";

export function mintToken(): string {
	const token = randomBytes(32).toString("base64url");
	noteSecret(token);
	return token;
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
	noteSecret(record.token);
	writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
}

export function removeSessionToken(paths: DgPaths, sessionId: string): void {
	rmSync(sessionFilePath(paths, sessionId), { force: true });
}

export function readSessionToken(paths: DgPaths, sessionId: string): string {
	const override = process.env.DG_SESSION_TOKEN;
	if (override !== undefined) {
		noteSecret(override);
		return override;
	}
	const raw = readFileSync(sessionFilePath(paths, sessionId), "utf8");
	const token = (JSON.parse(raw) as { token: string }).token;
	noteSecret(token);
	return token;
}

export type SessionIdentityRecord = {
	sessionId: string;
	cwd: string;
	agentIdentity: string;
};

/** Plaintext identity rows from the daemon database. Tokens stay encrypted and are not read here. */
export function readSessionIdentities(dbPath: string): SessionIdentityRecord[] {
	if (!existsSync(dbPath)) return [];
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true, strict: true });
		const columns = db.query("PRAGMA table_info(sessions)").all() as {
			name: string;
		}[];
		const names = new Set(columns.map((column) => column.name));
		if (!names.has("cwd") || !names.has("agent_identity") || !names.has("state")) {
			return [];
		}
		const rows = db
			.query(
				`SELECT id, cwd, agent_identity FROM sessions
				 WHERE state = 'active' AND cwd IS NOT NULL AND agent_identity IS NOT NULL`,
			)
			.all() as { id: string; cwd: string; agent_identity: string }[];
		return rows.map((row) => ({
			sessionId: row.id,
			cwd: row.cwd,
			agentIdentity: row.agent_identity,
		}));
	} catch {
		return [];
	} finally {
		db?.close();
	}
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
export function selectSoleSession(
	records: SessionTokenRecord[],
	cwd = realpathSync(process.cwd()),
): SessionTokenRecord {
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
	const match = matches[0];
	if (!match) {
		throw new DgCliError(
			`cannot resolve a session for cwd ${cwd}: found 0 matches; pass --session <id>.`,
		);
	}
	return match;
}

export function soleSessionForCwd(sessionsDir: string): SessionTokenRecord {
	return selectSoleSession(readSessionFiles(sessionsDir));
}
