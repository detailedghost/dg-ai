import { existsSync } from "node:fs";
import { vizConfig } from "../config";
import { die } from "../io";
import { doStop, stopOrphanListener } from "../server";

export async function cmdStop(): Promise<void> {
	const { pidFile, port } = vizConfig();
	if (existsSync(pidFile)) {
		doStop();
		return;
	}
	if (await stopOrphanListener()) return;
	die(`no running server found for port ${port}`);
}
