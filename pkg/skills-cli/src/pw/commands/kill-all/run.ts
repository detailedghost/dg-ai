import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
	DAEMON_PATTERN,
	isLive,
	isWindowsSession,
	readAll,
	remove,
	runtimeDir,
	type SessionRecord,
	signalDaemon,
} from "../../core/registry";
import type { ClientHandler } from "../../core/spec";
import { browserSurvived, closeWindowsBrowser } from "../../core/windows";

/** Returns the Windows profiles whose browser did not close; their records stay for a retry. */
export async function killRegistered(
	records: SessionRecord[],
	closeBrowser: (profileDir: string) => Promise<unknown> = closeWindowsBrowser,
): Promise<string[]> {
	const profiles = [
		...new Set(
			records.filter(isWindowsSession).map((record) => record.profileDir),
		),
	];
	const outcomes = await Promise.all(
		profiles.map((profileDir) =>
			closeBrowser(profileDir).then(
				(exit) => (browserSurvived(exit) ? profileDir : null),
				() => profileDir,
			),
		),
	);
	const failed = outcomes.filter(
		(profileDir): profileDir is string => profileDir !== null,
	);
	for (const record of records) signalDaemon(record, "SIGKILL");
	for (const record of records) {
		if (!(isWindowsSession(record) && failed.includes(record.profileDir)))
			remove(record.key);
	}
	for (const file of readdirSync(runtimeDir("sock")))
		rmSync(path.join(runtimeDir("sock"), file), { force: true });
	return failed;
}

const killAll: ClientHandler = async (_args, env) => {
	const records = readAll();
	const running = records.filter(isLive).length;
	const failed = await killRegistered(records);
	Bun.spawnSync(["pkill", "-9", "-f", DAEMON_PATTERN], {
		stdout: "ignore",
		stderr: "ignore",
	});
	env.out(`### Killed ${running} browser session${running === 1 ? "" : "s"}.`);
	if (failed.length === 0) return 0;
	env.err(
		`### Error\nCould not close the Windows browser for: ${failed.join(", ")}. Run pw kill-all again.`,
	);
	return 1;
};

export default killAll;
