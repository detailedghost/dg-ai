#!/usr/bin/env bun
/**
 * Evidence artifact for the WSL-to-Windows loopback assumption this whole
 * package is built on: a WSL-side daemon bound to 127.0.0.1 is reachable
 * from a Windows-side browser ONLY when WSL uses mirrored networking mode.
 * No CI runner hosts a real WSL+Windows pair, so this is a manual probe run
 * by hand on a real dev box — it is not part of `bun test` and never will be.
 *
 * Usage (from a WSL shell, with a dg-server daemon already started):
 *   bun run pkg/dg-server/scripts/verify-wsl-loopback.ts
 *
 * What it checks automatically:
 *   1. This process is actually running under WSL.
 *   2. The daemon's own /health answers on the WSL side.
 * What it asks a human to confirm:
 *   3. The printed URL, opened in a Windows-side browser (not WSL's own),
 *      loads the bootstrap page and completes a WebSocket handshake to /ws.
 */
import { isWSL, resolveDgPaths } from "@dg/common/node";
import { isDaemonLive, readLockfile } from "../src/server/lockfile";

async function main(): Promise<void> {
	console.log("=== dg-server WSL-loopback verification ===\n");

	if (!isWSL()) {
		console.error(
			"This process is not running under WSL — run it from a WSL shell " +
				"against a WSL-side dg-server daemon. Nothing else to verify here.",
		);
		process.exit(1);
	}
	console.log("[1/3] Running under WSL: yes");

	const paths = resolveDgPaths();
	const handle = readLockfile(paths);
	if (!handle) {
		console.error(
			`No lockfile at ${paths.lockfilePath} — start a daemon first: ` +
				"`bun run pkg/dg-server/src/index.ts start`.",
		);
		process.exit(1);
	}
	const live = await isDaemonLive(handle);
	if (!live) {
		console.error(
			`Lockfile found but /health on port ${handle.port} did not answer with ` +
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
