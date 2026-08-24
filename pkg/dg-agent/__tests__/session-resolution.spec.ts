import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	sendConnectHandshake,
	spawnServe,
	waitForHealth,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "@dg/dg-daemon/test-harness";
import { runCli } from "./cli-wire";

let dgHome: string;
let dirA: string;
let dirB: string;
let dirC: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
	for (const d of [dirA, dirB, dirC]) {
		if (d) rmSync(d, { recursive: true, force: true });
	}
});

async function startSessionIn(port: number, cwd: string) {
	return registerSession(port, { cwd });
}

describe("CLI session resolution by cwd", () => {
	it("two sessions sharing one cwd: an unqualified verb errors listing both candidates, and neither session closes", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		dirA = realpathSync(mkdtempSync(join(tmpdir(), "dg-cwd-a-")));
		spawnServe(dgHome, port);
		await waitForHealth(port);

		const first = await startSessionIn(port, dirA);
		const second = await startSessionIn(port, dirA);

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, first, CHAT_PROTOCOL_VERSION);
		const frames = collectFrames(page);

		const result = await runCli(dgHome, port, ["close"], {}, { cwd: dirA });

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain(first.sessionId);
		expect(result.stderr).toContain(second.sessionId);

		await new Promise((r) => setTimeout(r, 300));
		expect(
			frames.some(
				(f) =>
					typeof f === "object" &&
					f !== null &&
					(f as { type?: string }).type === "session-closed",
			),
		).toBe(false);
		page.close();
	});

	it("zero cwd matches: an unqualified verb errors rather than guessing", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		dirA = realpathSync(mkdtempSync(join(tmpdir(), "dg-cwd-a-")));
		dirC = realpathSync(mkdtempSync(join(tmpdir(), "dg-cwd-c-empty-")));
		spawnServe(dgHome, port);
		await waitForHealth(port);

		await startSessionIn(port, dirA);

		const result = await runCli(dgHome, port, ["close"], {}, { cwd: dirC });

		expect(result.exitCode).not.toBe(0);
	});

	it("--session selects the named session even when cwd resolution alone would be ambiguous", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		dirA = realpathSync(mkdtempSync(join(tmpdir(), "dg-cwd-a-")));
		spawnServe(dgHome, port);
		await waitForHealth(port);

		const first = await startSessionIn(port, dirA);
		await startSessionIn(port, dirA);

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, first, CHAT_PROTOCOL_VERSION);
		const frames = collectFrames(page);

		const result = await runCli(
			dgHome,
			port,
			["close", "--session", first.sessionId],
			{},
			{ cwd: dirA },
		);
		expect(result.exitCode).toBe(0);

		await waitForValue(
			() =>
				frames.find(
					(f) =>
						typeof f === "object" &&
						f !== null &&
						(f as { type?: string; sessionId?: string }).type ===
							"session-closed" &&
						(f as { sessionId?: string }).sessionId === first.sessionId,
				),
			3000,
			"session-closed for the explicitly named session",
		);
		page.close();
	});

	it("exactly one cwd match resolves unambiguously with no --session flag", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		dirB = realpathSync(mkdtempSync(join(tmpdir(), "dg-cwd-b-unique-")));
		spawnServe(dgHome, port);
		await waitForHealth(port);

		const only = await startSessionIn(port, dirB);

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, only, CHAT_PROTOCOL_VERSION);
		const frames = collectFrames(page);

		const result = await runCli(dgHome, port, ["close"], {}, { cwd: dirB });
		expect(result.exitCode).toBe(0);

		await waitForValue(
			() =>
				frames.find(
					(f) =>
						typeof f === "object" &&
						f !== null &&
						(f as { type?: string }).type === "session-closed",
				),
			3000,
			"session-closed for the single cwd match",
		);
		page.close();
	});

	it("matches via realpath: invoking from a symlink to the registered cwd still resolves unambiguously", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		dirB = realpathSync(mkdtempSync(join(tmpdir(), "dg-cwd-real-")));
		const symlinkDir = join(tmpdir(), `dg-cwd-symlink-${Date.now()}`);
		symlinkSync(dirB, symlinkDir);
		spawnServe(dgHome, port);
		await waitForHealth(port);

		const only = await startSessionIn(port, dirB);

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, only, CHAT_PROTOCOL_VERSION);
		const frames = collectFrames(page);

		try {
			const result = await runCli(
				dgHome,
				port,
				["close"],
				{},
				{ cwd: symlinkDir },
			);
			expect(result.exitCode).toBe(0);

			await waitForValue(
				() =>
					frames.find(
						(f) =>
							typeof f === "object" &&
							f !== null &&
							(f as { type?: string }).type === "session-closed",
					),
				3000,
				"session-closed via the symlinked cwd",
			);
		} finally {
			rmSync(symlinkDir, { force: true });
			page.close();
		}
	});
});
