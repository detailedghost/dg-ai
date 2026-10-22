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
import { closeWindowsBrowser } from "../../core/windows";

export async function killRegistered(
	records: SessionRecord[],
	closeBrowser: (profileDir: string) => Promise<unknown> = closeWindowsBrowser,
): Promise<void> {
	const profiles = new Set(records.filter(isWindowsSession).map((record) => record.profileDir));
	await Promise.all([...profiles].map((profileDir) => closeBrowser(profileDir).catch(() => undefined)));
	for (const record of records) signalDaemon(record, "SIGKILL");
	for (const record of records) remove(record.key);
	for (const file of readdirSync(runtimeDir("sock"))) rmSync(path.join(runtimeDir("sock"), file), { force: true });
}

const killAll: ClientHandler = async (_args, env) => {
	const records = readAll();
	const running = records.filter(isLive).length;
	await killRegistered(records);
	Bun.spawnSync(["pkill", "-9", "-f", DAEMON_PATTERN], { stdout: "ignore", stderr: "ignore" });
	env.out(`### Killed ${running} browser session${running === 1 ? "" : "s"}.`);
	return 0;
};

export default killAll;
