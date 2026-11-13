import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { wait } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { readDaemonLog, waitForPidFile } from "../utils/daemon-harness";
import { bootWithServices, type ServiceDaemon } from "../utils/service-daemon";

let daemon: ServiceDaemon | undefined;
afterEach(async () => {
	await daemon?.dispose();
	daemon = undefined;
});

async function eventually<T>(read: () => T | undefined, ms = 8000): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await wait(50);
	}
}

const markerWriter = (marker: string, pidPath: string) =>
	`const fs = require("node:fs");
	fs.writeFileSync(${JSON.stringify(marker)}, String(fs.existsSync(${JSON.stringify(pidPath)})));
	setInterval(() => {}, 1000);`;

describe("daemon boot with an autostart service", () => {
	it("has the daemon pid file on disk when the service starts and logs listening before started", async () => {
		let marker = "";
		daemon = await bootWithServices((dgHome) => {
			marker = join(dgHome, "pidfile-seen.txt");
			const { pidPath } = resolveDgPaths({ env: { DG_HOME: dgHome } });
			return {
				bot: {
					argv: [process.execPath, "-e", markerWriter(marker, pidPath)],
					cwd: dgHome,
					autostart: true,
				},
			};
		});
		await eventually(() => (existsSync(marker) ? true : undefined));
		expect(readFileSync(marker, "utf8")).toBe("true");
		await waitForPidFile(daemon.dgHome);

		const { dgHome } = daemon;
		const log = await eventually(() => {
			const text = readDaemonLog(dgHome);
			return text.includes("service bot started") ? text : undefined;
		});
		const listening = log.indexOf("dg-daemon listening on");
		expect(listening).toBeGreaterThanOrEqual(0);
		expect(listening).toBeLessThan(log.indexOf("service bot started"));
	}, 20_000);
});
