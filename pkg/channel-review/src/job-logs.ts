import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const JOB_LOG_TTL_MS = 14 * 24 * 3_600_000;

export function pruneJobLogs(dir: string, now: Date): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.endsWith(".log")) continue;
		const file = join(dir, name);
		try {
			if (now.getTime() - statSync(file).mtimeMs > JOB_LOG_TTL_MS) {
				rmSync(file, { force: true });
			}
		} catch {
			continue;
		}
	}
}
