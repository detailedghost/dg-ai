#!/usr/bin/env bun
import { isWSL, resolveDgPaths } from "@dg/common/node";
import { isDaemonLive, readPidFile } from "../src/server/pidfile";

async function main(): Promise<void> {
	console.log("=== dg-daemon WSL-loopback verification ===\n");

	if (!isWSL()) {
		console.error(
			"This process is not running under WSL — run it from a WSL shell " +
				"against a WSL-side dg-daemon daemon. Nothing else to verify here.",
		);
		process.exit(1);
	}
	console.log("[1/3] Running under WSL: yes");

	const paths = resolveDgPaths();
	const handle = readPidFile(paths);
	if (!handle) {
		console.error(
			`No pid file at ${paths.pidPath} — start a daemon first: ` +
				"`bun run pkg/dg-daemon/src/index.ts start`.",
		);
		process.exit(1);
	}
	const live = await isDaemonLive(handle);
	if (!live) {
		console.error(
			`Pid file found but /health on port ${handle.port} did not answer with ` +
				"a matching instanceId. Start (or restart) the daemon and re-run this script.",
		);
		process.exit(1);
	}
	console.log(
		`[2/3] Daemon reachable from the WSL side on 127.0.0.1:${handle.port} ` +
			`(instance ${handle.instanceId})`,
	);

	console.log(
		"[3/3] MANUAL STEP — open a browser on the WINDOWS side (not inside WSL) " +
			`and navigate to: http://127.0.0.1:${handle.port}/start\n\n` +
			"Confirm:\n" +
			"  - The page loads (a fetch failure here means WSL is in NAT mode —\n" +
			"    set networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig,\n" +
			"    then run `wsl --shutdown` and restart).\n" +
			"  - The page's console shows a WebSocket connecting to /ws with no error.\n\n" +
			"This script cannot drive a Windows-side browser itself — record the\n" +
			"result of this manual check in the PR/slice notes.",
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
