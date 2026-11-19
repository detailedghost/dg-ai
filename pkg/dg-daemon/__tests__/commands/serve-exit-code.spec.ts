import { afterEach, describe, expect, it } from "bun:test";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	killDaemonByPidFile,
	spawnServe,
	waitForDaemonExit,
	waitForHealth,
} from "../utils/daemon-harness";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 30_000);

function boot() {
	const dgHome = freshDgHome();
	const port = allocatePort();
	const proc = spawnServe(dgHome, port);
	cleanups.push(async () => {
		killDaemonByPidFile(dgHome);
		proc.kill("SIGKILL");
		await waitForDaemonExit(dgHome).catch(() => {});
		cleanupDgHome(dgHome);
	});
	return { dgHome, port, proc };
}

const posix = describe.skipIf(process.platform === "win32");

posix("dg-daemon serve exit code under a service manager", () => {
	it("exits with code 0 when it gets SIGTERM, so Restart=on-failure does not start it again", async () => {
		const { port, proc } = boot();
		await waitForHealth(port);

		proc.kill("SIGTERM");

		expect(await proc.exited).toBe(0);
	}, 30_000);

	it("exits with code 0 when a daemon is live in the same home, so a unit does not start it again", async () => {
		const { dgHome, port } = boot();
		await waitForHealth(port);

		const second = spawnServe(dgHome, port);
		cleanups.push(() => void second.kill("SIGKILL"));

		expect(await second.exited).toBe(0);
		await waitForHealth(port);
	}, 30_000);
});
