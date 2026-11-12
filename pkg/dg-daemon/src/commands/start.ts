import type { DaemonHandle } from "@dg/common";
import { ensureDaemonRunning, resolveDgPaths } from "@dg/common/node";

export function startedLine(handle: DaemonHandle, started: boolean): string {
	const state = started ? "started on" : "already running on";
	return `dg-daemon ${state} 127.0.0.1:${handle.port} (pid ${handle.pid}, version ${handle.versions.package})`;
}

export async function cmdStart(
	options: { json?: boolean } = {},
): Promise<void> {
	const { handle, started } = await ensureDaemonRunning(resolveDgPaths());
	if (options.json) {
		console.log(
			JSON.stringify({
				started,
				pid: handle.pid,
				port: handle.port,
				version: handle.versions.package,
			}),
		);
		return;
	}
	console.log(startedLine(handle, started));
}
