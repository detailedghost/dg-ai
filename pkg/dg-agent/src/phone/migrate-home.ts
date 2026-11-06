import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { copyTree, treeMatches } from "@dg/common/node";
import { nip19 } from "nostr-tools";

export type MoveResult = { moved: boolean; failures: string[] };

export type MoveSeams = { afterCopy?: (copy: string) => void };

export const ROLLBACK_LINE = "rollback: dg-agent phone __rollback-home";

function keyProblems(db: Database, dbPath: string): string[] {
	const rows = db
		.query("SELECT id, nsec FROM keys WHERE nsec IS NOT NULL")
		.all() as { id: string; nsec: string }[];
	return rows.flatMap((row) => {
		try {
			if (nip19.decode(row.nsec.trim()).type === "nsec") return [];
		} catch {}
		return [`${dbPath}: key ${row.id} does not load`];
	});
}

/** Problems with a copied phone root: a failed `PRAGMA integrity_check` or a file key that does not decode. */
function verifyPhoneRoot(root: string): string[] {
	const dbPath = join(root, "phone.db");
	if (!existsSync(dbPath)) return [];
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { strict: true });
		const row = db.query("PRAGMA integrity_check").get() as {
			integrity_check: string;
		} | null;
		const result = row?.integrity_check ?? "no result";
		if (result !== "ok") return [`${dbPath}: ${result}`];
		return keyProblems(db, dbPath);
	} catch (err) {
		return [`${dbPath}: ${err instanceof Error ? err.message : String(err)}`];
	} finally {
		db?.close();
	}
}

function copyVerified(from: string, to: string, seams: MoveSeams): string[] {
	if (existsSync(to)) return [`${to} already exists`];
	try {
		mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
		copyTree(from, to);
		seams.afterCopy?.(to);
		const problems = treeMatches(from, to)
			? verifyPhoneRoot(to)
			: [`${to} does not match ${from}`];
		if (problems.length > 0) rmSync(to, { recursive: true, force: true });
		return problems;
	} catch (err) {
		rmSync(to, { recursive: true, force: true });
		return [`${to}: ${err instanceof Error ? err.message : String(err)}`];
	}
}

/**
 * Moves the phone state root: copy, open the copied `phone.db` with `PRAGMA integrity_check`,
 * decode every file key, and only then remove the old root. A failure removes the copy and keeps the old root.
 */
export function movePhoneState(
	oldRoot: string,
	newRoot: string,
	log: (line: string) => void,
	seams: MoveSeams = {},
): MoveResult {
	if (!existsSync(oldRoot)) return { moved: false, failures: [] };
	const failures = copyVerified(oldRoot, newRoot, seams);
	if (failures.length > 0) {
		log(
			`phone state kept at ${oldRoot}; verify failed: ${failures.join("; ")}`,
		);
		log(ROLLBACK_LINE);
		return { moved: false, failures };
	}
	rmSync(oldRoot, { recursive: true, force: true });
	return { moved: true, failures: [] };
}

/** Copies the phone state back to the old root for an older release; the new root stays in place. */
export function rollbackPhoneState(
	newRoot: string,
	oldRoot: string,
	log: (line: string) => void,
): MoveResult {
	if (!existsSync(newRoot))
		return { moved: false, failures: [`${newRoot} does not exist`] };
	const failures = copyVerified(newRoot, oldRoot, {});
	if (failures.length > 0) {
		log(`phone state not copied back: ${failures.join("; ")}`);
		return { moved: false, failures };
	}
	log(`phone state copied back to ${oldRoot}`);
	return { moved: true, failures: [] };
}

/** True when the root holds only a `phone.db` whose every table is empty, so nothing would be lost by setting it aside. */
export function phoneRootUnused(root: string): boolean {
	const dbPath = join(root, "phone.db");
	if (!existsSync(dbPath)) return false;
	if (readdirSync(root).some((name) => !name.startsWith("phone.db"))) return false;
	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true, strict: true });
		const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
		return tables.every(({ name }) => db?.query(`SELECT 1 FROM "${name}" LIMIT 1`).get() === null);
	} catch {
		return false;
	} finally {
		db?.close();
	}
}

/** Renames an unused root to `<root>.empty-<timestamp>`; returns false when the rename fails. */
export function setAsideUnusedRoot(root: string, now: () => number = Date.now): boolean {
	try {
		renameSync(root, `${root}.empty-${now()}`);
		return true;
	} catch {
		return false;
	}
}
