import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { STALE_LOCK_MS, sessionDir, vizConfig } from "../config";
import { die, note } from "../io";
import { tokenFilePath } from "../respond-core";
import { doStop } from "../server";
import { validateSlug } from "../session";

const USAGE =
	"usage: dg-skills viz clean <slug|--all|--orphans|--stale|--older-than <duration>>";

function payloadIsOldEnoughToBeOrphan(dir: string): boolean {
	try {
		return Date.now() - statSync(`${dir}/payload.json`).mtimeMs > STALE_LOCK_MS;
	} catch {
		return false;
	}
}

function isSessionDir(vizDir: string, d: string): boolean {
	const dir = `${vizDir}/${d}`;
	return (
		(existsSync(`${dir}/payload.json`) && existsSync(tokenFilePath(dir))) ||
		existsSync(`${dir}/tracks`)
	);
}

function parseDuration(s: string): number {
	const m = s.match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/);
	if (!m)
		die(
			`invalid duration: "${s}" (expected e.g. 30m, 24h, 7d, or a plain number of seconds)`,
		);
	const n = parseFloat(m[1]);
	const unit = (m[2] ?? "s") as "s" | "m" | "h" | "d";
	return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

function removeSessions(vizDir: string, slugs: string[]): void {
	for (const s of slugs)
		rmSync(`${vizDir}/${s}`, { recursive: true, force: true });
}

export function cmdClean(rest: string[]): void {
	const target = rest[0];
	if (!target) die(USAGE);
	const { vizDir } = vizConfig();

	if (target === "--orphans") {
		if (!existsSync(vizDir)) {
			note("nothing to clean");
			return;
		}
		const orphans = readdirSync(vizDir).filter((d) => {
			const dir = `${vizDir}/${d}`;
			return (
				existsSync(`${dir}/payload.json`) &&
				!existsSync(tokenFilePath(dir)) &&
				payloadIsOldEnoughToBeOrphan(dir)
			);
		});
		removeSessions(vizDir, orphans);
		note(`cleaned ${orphans.length} orphan staging dir(s)`);
		return;
	}

	if (target === "--all") {
		doStop();
		if (!existsSync(vizDir)) {
			note("nothing to clean");
			return;
		}
		const sessions = readdirSync(vizDir).filter(
			(d) => !d.endsWith(".log") && isSessionDir(vizDir, d),
		);
		removeSessions(vizDir, sessions);
		note(`cleaned ${sessions.length} session(s)`);
		return;
	}

	if (target === "--stale") {
		if (!existsSync(vizDir)) {
			note("nothing to clean");
			return;
		}
		const stale = readdirSync(vizDir).filter((d) => {
			const dir = `${vizDir}/${d}`;
			return existsSync(`${dir}/payload.json`) && existsSync(`${dir}/.stale`);
		});
		removeSessions(vizDir, stale);
		note(`cleaned ${stale.length} stale session(s)`);
		return;
	}

	if (target === "--older-than") {
		const durationArg = rest[1];
		if (!durationArg)
			die(
				"usage: dg-skills viz clean --older-than <duration> (e.g. 30m, 24h, 7d)",
			);
		const maxAgeMs = parseDuration(durationArg);
		if (!existsSync(vizDir)) {
			note("nothing to clean");
			return;
		}
		const older = readdirSync(vizDir).filter((d) => {
			if (d.endsWith(".log")) return false;
			const payload = `${vizDir}/${d}/payload.json`;
			if (!existsSync(payload)) return false;
			try {
				return Date.now() - statSync(payload).mtimeMs > maxAgeMs;
			} catch {
				return false;
			}
		});
		removeSessions(vizDir, older);
		note(`cleaned ${older.length} session(s) older than ${durationArg}`);
		return;
	}

	const slug = validateSlug(target);
	const dir = sessionDir(slug);
	if (!existsSync(dir)) die(`no session found: ${slug}`);
	rmSync(dir, { recursive: true, force: true });
	note(`cleaned session: ${slug}`);
}
