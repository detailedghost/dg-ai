import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { isWSL, resolveDgPaths, writePidFileAtomic } from "@dg/common/node";
import { CURRENT_SCHEMA_VERSION } from "../../src/store/schema";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	freshDgHome,
	killDaemonByPidFile,
	readPidFile,
	registerSession,
	runStatus,
	sendConnectHandshake,
	spawnServe,
	waitForClose,
	waitForHealth,
	waitForOpen,
	wsExtensionSocket,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

describe("dg-daemon status", () => {
	it("reports no live daemon when none has ever run", async () => {
		dgHome = freshDgHome();
		const result = await runStatus(dgHome);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("no live daemon");
	});

	it("reports the live daemon's status while it is running", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);
		await registerSession(port);

		const result = await runStatus(dgHome);
		expect(result.exitCode).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.daemon).toBe("dg-daemon");
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

	it("reports the connected extension's version and null again once it disconnects", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);
		const credentials = await registerSession(port);
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, credentials, CHAT_PROTOCOL_VERSION, "1.9.3");

		await new Promise((r) => setTimeout(r, 150));
		const version = async () =>
			JSON.parse((await runStatus(dgHome)).stdout).versions.extension;
		expect(await version()).toBe("1.9.3");

		const closed = waitForClose(page);
		page.close();
		await closed;
		await new Promise((r) => setTimeout(r, 150));
		expect(await version()).toBeNull();
	});

	it("tags the error for a rejected connect handshake so a page can tell a stale token from a daemon outage", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);
		const credentials = await registerSession(port);
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		const frames = collectFrames(page);
		sendConnectHandshake(
			page,
			{ ...credentials, token: "stale-token" },
			CHAT_PROTOCOL_VERSION,
		);

		await new Promise((r) => setTimeout(r, 300));
		expect(frames).toContainEqual(
			expect.objectContaining({ type: "error", code: "invalid-session" }),
		);
		page.close();
	});

	it("reports no live daemon and removes a stale pid file left by a hard-killed daemon", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);
		await registerSession(port);
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

	it("keeps the pid file and says the daemon does not answer when its pid runs but healthz is silent", async () => {
		dgHome = freshDgHome();
		const sleeper = Bun.spawn(
			[process.execPath, "-e", "setInterval(() => {}, 1000)"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		writePidFileAtomic(paths, {
			pid: sleeper.pid,
			port: allocatePort(),
			instanceId: crypto.randomUUID(),
			versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
		});

		try {
			const result = await runStatus(dgHome);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				`dg-daemon (pid ${sleeper.pid}) does not answer`,
			);
			expect(existsSync(paths.pidPath)).toBe(true);
		} finally {
			sleeper.kill("SIGKILL");
		}
	});
});
