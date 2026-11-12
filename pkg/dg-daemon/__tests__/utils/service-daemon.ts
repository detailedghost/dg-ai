import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	killDaemonByPidFile,
	spawnServe,
	waitForDaemonExit,
	waitForHealth,
} from "./daemon-harness";

export type ServiceDaemon = {
	dgHome: string;
	port: number;
	proc: ReturnType<typeof spawnServe>;
	paths: ReturnType<typeof resolveDgPaths>;
	dispose: () => Promise<void>;
};

export function writeServiceConfig(
	dgHome: string,
	services: Record<string, unknown>,
): void {
	const { daemonConfigPath } = resolveDgPaths({ env: { DG_HOME: dgHome } });
	mkdirSync(join(daemonConfigPath, ".."), { recursive: true });
	writeFileSync(daemonConfigPath, JSON.stringify({ services }));
}

/** Writes the config before the daemon boots, so autostart sees it. */
export async function bootWithServices(
	services: (dgHome: string) => Record<string, unknown>,
): Promise<ServiceDaemon> {
	const dgHome = freshDgHome();
	writeServiceConfig(dgHome, services(dgHome));
	const port = allocatePort();
	const proc = spawnServe(dgHome, port);
	await waitForHealth(port, 8000);
	return {
		dgHome,
		port,
		proc,
		paths: resolveDgPaths({ env: { DG_HOME: dgHome } }),
		dispose: async () => {
			killDaemonByPidFile(dgHome);
			proc.kill("SIGKILL");
			await proc.exited;
			await waitForDaemonExit(dgHome).catch(() => {});
			cleanupDgHome(dgHome);
		},
	};
}
