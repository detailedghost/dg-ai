import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wait } from "@dg/common";
import { isAlive } from "@dg/common/node";
import { bootWithServices, type ServiceDaemon } from "../utils/service-daemon";

let daemon: ServiceDaemon | undefined;
afterEach(async () => {
	await daemon?.dispose();
	daemon = undefined;
});

const stubbornService =
	(pidFile: string, stopTimeoutMs: number) => (cwd: string) => ({
		argv: [
			process.execPath,
			"-e",
			`process.on("SIGTERM", () => {});
		require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
		setInterval(() => {}, 1000);`,
		],
		cwd,
		autostart: true,
		stopTimeoutMs,
	});

async function servicePid(pidFile: string): Promise<number> {
	const deadline = Date.now() + 8000;
	while (!existsSync(pidFile) || readFileSync(pidFile, "utf8") === "") {
		if (Date.now() > deadline) throw new Error("service never wrote its pid");
		await wait(25);
	}
	return Number(readFileSync(pidFile, "utf8"));
}

describe("daemon shutdown with services that ignore SIGTERM", () => {
	it("exits only after the service stopTimeoutMs and leaves the service gone", async () => {
		let pidFile = "";
		daemon = await bootWithServices((dgHome) => {
			pidFile = join(dgHome, "bot.pid-seen");
			return { bot: stubbornService(pidFile, 500)(dgHome) };
		});
		const pid = await servicePid(pidFile);

		const sentAt = Date.now();
		daemon.proc.kill("SIGTERM");
		await daemon.proc.exited;
		const elapsed = Date.now() - sentAt;

		expect(elapsed).toBeGreaterThanOrEqual(500);
		expect(elapsed).toBeLessThan(5000);
		expect(isAlive(pid)).toBe(false);
	}, 20_000);

	it("stops services together and kills each only at the end of its own stopTimeoutMs", async () => {
		let fastFile = "";
		let slowFile = "";
		daemon = await bootWithServices((dgHome) => {
			fastFile = join(dgHome, "fast.pid-seen");
			slowFile = join(dgHome, "slow.pid-seen");
			return {
				fast: stubbornService(fastFile, 800)(dgHome),
				slow: stubbornService(slowFile, 1500)(dgHome),
			};
		});
		const fast = await servicePid(fastFile);
		const slow = await servicePid(slowFile);

		const sentAt = Date.now();
		daemon.proc.kill("SIGTERM");
		let fastGoneAt: number | undefined;
		let slowAliveWhenFastGone: boolean | undefined;
		while (fastGoneAt === undefined) {
			if (!isAlive(fast)) {
				fastGoneAt = Date.now() - sentAt;
				slowAliveWhenFastGone = isAlive(slow);
			} else await wait(10);
		}
		await daemon.proc.exited;
		const exitedAt = Date.now() - sentAt;

		expect(fastGoneAt).toBeGreaterThanOrEqual(800);
		expect(slowAliveWhenFastGone).toBe(true);
		expect(isAlive(slow)).toBe(false);
		expect(exitedAt).toBeGreaterThanOrEqual(1500);
		expect(exitedAt).toBeLessThan(800 + 1500 + 2000);
	}, 20_000);
});
