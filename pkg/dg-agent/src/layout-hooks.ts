import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LayoutHooks, StopResult } from "@dg/common/node/layout";
import { nip19 } from "nostr-tools";
import { isOurListener as defaultIsOurListener, readListenerPid } from "./phone/listener";

export type PhoneLayoutDeps = {
	isOurListener: (pid: number) => boolean;
	kill: (pid: number, signal: NodeJS.Signals) => void;
	sleep: (ms: number) => Promise<void>;
};

type PhoneHooks = Required<Pick<LayoutHooks, "phone.verify" | "phone.stop">>;

function keyProblems(db: Database, dbPath: string): string[] {
	const rows = db.query("SELECT id, nsec FROM keys WHERE nsec IS NOT NULL").all() as { id: string; nsec: string }[];
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
		const row = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
		const result = row?.integrity_check ?? "no result";
		return result === "ok" ? keyProblems(db, dbPath) : [`${dbPath}: ${result}`];
	} catch (err) {
		return [`${dbPath}: ${err instanceof Error ? err.message : String(err)}`];
	} finally {
		db?.close();
	}
}

async function stopLegacyListener(legacyPhoneRoot: string, { isOurListener, kill, sleep }: PhoneLayoutDeps): Promise<StopResult> {
	const legacyPaths = { phoneRoot: legacyPhoneRoot };
	const running = readListenerPid(legacyPaths);
	if (!running || running.pid === process.pid || !isOurListener(running.pid)) return "stopped";
	const { stopRunningListener } = await import("./phone/commands");
	try {
		await stopRunningListener({ paths: legacyPaths, isOurListener, kill, sleep }, running.pid);
		return "stopped";
	} catch {
		return "still-running";
	}
}

/** The `phone.verify` and `phone.stop` hooks the layout table names for the phone folder. */
export function phoneLayoutHooks({
	isOurListener = defaultIsOurListener,
	kill = (pid, signal) => process.kill(pid, signal),
	sleep = (ms) => Bun.sleep(ms),
}: Partial<PhoneLayoutDeps> = {}): PhoneHooks {
	return {
		"phone.verify": verifyPhoneRoot,
		"phone.stop": (legacyPhoneRoot) => stopLegacyListener(legacyPhoneRoot, { isOurListener, kill, sleep }),
	};
}
