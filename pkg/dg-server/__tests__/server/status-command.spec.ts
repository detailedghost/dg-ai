import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { isWSL, resolveDgPaths } from "@dg/common/node";
import { CURRENT_SCHEMA_VERSION } from "../../src/store/schema";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	killDaemonByPidFile,
	readPidFile,
	runStart,
	runStatus,
	waitForHealth,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

describe("dg-server status", () => {
	it("reports no live daemon when none has ever run", async () => {
		dgHome = freshDgHome();
		const result = await runStatus(dgHome);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("no live daemon");
	});

	it("reports the live daemon's status while it is running", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		await runStart(dgHome, port);
		await waitForHealth(port);

		const result = await runStatus(dgHome);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.daemon).toBe("dg-server");
		expect(report.boundPort).toBe(port);
		expect(report.sessionCount).toBeGreaterThan(0);

		expect(typeof report.keySource).toBe("string");
		expect(report.keySource.length).toBeGreaterThan(0);
		expect(
			isWSL()
				? ["mirrored", "nat", "unknown"].includes(report.wslNetworkingMode)
				: report.wslNetworkingMode === "n/a",
		).toBe(true);
		expect(typeof report.versions.package).toBe("string");
		expect(report.versions.protocol).toBe(CHAT_PROTOCOL_VERSION);
		expect(report.versions.userVersion).toBe(CURRENT_SCHEMA_VERSION);
		expect(report.versions.extension).toBeNull();
	});

	it("reports no live daemon and removes a stale pid file left by a hard-killed daemon", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		await runStart(dgHome, port);
		await waitForHealth(port);
		const handle = readPidFile(dgHome);
		process.kill(handle.pid, "SIGKILL");

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const deadline = Date.now() + 3000;
		let status = await runStatus(dgHome);
		while (
			status.stdout.includes("no live daemon") === false &&
			Date.now() < deadline
		) {
			await new Promise((r) => setTimeout(r, 100));
			status = await runStatus(dgHome);
		}

		expect(status.stdout).toContain("no live daemon");
		expect(existsSync(paths.pidPath)).toBe(false);
	}, 20000);
});
