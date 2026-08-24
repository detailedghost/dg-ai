import { afterEach, describe, expect, it } from "bun:test";
import {
	closeSync,
	existsSync,
	ftruncateSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_MAX_ASSET_BYTES, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { getConfiguredAssetDirectory } from "../../src/assets/config";
import {
	startWithSession as bootDaemonSession,
	cleanupDgHome,
	collectFrames,
	findFileContaining,
	killDaemonByPidFile,
	sendConnectHandshake,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";
import { nextParsedMessage, runCli } from "./cli-wire";

let dgHome: string;
let scratchDir: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

async function startWithSession() {
	const started = await bootDaemonSession();
	dgHome = started.dgHome;
	return started;
}

describe("dg-server spawn", () => {
	it("registers a new session through the daemon's session-create handler, and it shows up in the session list", async () => {
		const { port, bootstrap } = await startWithSession();
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page);
		const frames = collectFrames(page);

		const result = await runCli(dgHome, port, [
			"spawn",
			"--session",
			bootstrap.sessionId,
			"--workset",
			"my-workset",
		]);
		expect(result.exitCode).toBe(0);

		const list = (await waitForValue(
			() =>
				frames.find(
					(f) =>
						typeof f === "object" &&
						f !== null &&
						(f as { type?: string }).type === "session-list" &&
						(f as { sessions: { workset?: string }[] }).sessions.some(
							(s) => s.workset === "my-workset",
						),
				),
			3000,
			"session-list including the spawned workset",
		)) as { sessions: { agentIdentity: string; workset?: string }[] };

		const spawned = list.sessions.find((s) => s.workset === "my-workset");
		expect(spawned).toBeDefined();
		expect(spawned?.agentIdentity).toBe(bootstrap.agentIdentity);
		page.close();
	});

	it("binds the spawned session to a distinct agent identity via --agent-identity", async () => {
		const { port, bootstrap } = await startWithSession();
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page);
		const frames = collectFrames(page);

		const result = await runCli(dgHome, port, [
			"spawn",
			"--session",
			bootstrap.sessionId,
			"--agent-identity",
			"a-different-agent",
		]);
		expect(result.exitCode).toBe(0);

		const list = (await waitForValue(
			() =>
				frames.find(
					(f) =>
						typeof f === "object" &&
						f !== null &&
						(f as { type?: string }).type === "session-list" &&
						(f as { sessions: { agentIdentity: string }[] }).sessions.some(
							(s) => s.agentIdentity === "a-different-agent",
						),
				),
			3000,
			"session-list including the spawned agent identity",
		)) as { sessions: { agentIdentity: string }[] };

		const spawned = list.sessions.find(
			(s) => s.agentIdentity === "a-different-agent",
		);
		expect(spawned).toBeDefined();
		expect(spawned?.agentIdentity).not.toBe(bootstrap.agentIdentity);
		page.close();
	});
});

describe("dg-server close", () => {
	it("emits the session-close frame — a listening page sees session-closed", async () => {
		const { port, bootstrap } = await startWithSession();
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page);
		const frames = collectFrames(page);

		const result = await runCli(dgHome, port, [
			"close",
			"--session",
			bootstrap.sessionId,
		]);
		expect(result.exitCode).toBe(0);

		await waitForValue(
			() =>
				frames.find(
					(f) =>
						typeof f === "object" &&
						f !== null &&
						(f as { type?: string }).type === "session-closed" &&
						(f as { sessionId?: string }).sessionId === bootstrap.sessionId,
				),
			3000,
			"session-closed broadcast",
		);
		page.close();
	});
});

describe("dg-server stage", () => {
	it("registers an assets row and stages ENCRYPTED bytes under the configured directory, retrievable byte-identical", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = mkdtempSync(join(tmpdir(), "dg-stage-test-"));
		const sourcePath = join(scratchDir, "picture.png");
		const marker = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		writeFileSync(sourcePath, marker);

		const result = await runCli(dgHome, port, [
			"stage",
			sourcePath,
			"--session",
			bootstrap.sessionId,
		]);

		expect(result.exitCode).toBe(0);
		const assetId = result.stdout.trim();
		expect(assetId.length).toBeGreaterThan(0);

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const sessionDir = join(
			getConfiguredAssetDirectory(paths),
			bootstrap.sessionId,
		);
		expect(existsSync(join(sessionDir, assetId))).toBe(true);
		expect(findFileContaining(getConfiguredAssetDirectory(paths), marker)).toBe(
			false,
		);

		const resp = await fetch(
			`http://127.0.0.1:${port}/assets/${encodeURIComponent(assetId)}`,
			{
				headers: {
					Host: `127.0.0.1:${port}`,
					"X-Dg-Session-Id": bootstrap.sessionId,
					"X-Dg-Session-Token": bootstrap.token,
				},
			},
		);
		expect(resp.status).toBe(200);
		expect(Buffer.from(await resp.arrayBuffer()).equals(marker)).toBe(true);
	});

	it("refuses a source file over CHAT_MAX_ASSET_BYTES without staging anything", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = mkdtempSync(join(tmpdir(), "dg-stage-huge-"));
		const sourcePath = join(scratchDir, "huge.bin");
		const fd = openSync(sourcePath, "w");
		ftruncateSync(fd, CHAT_MAX_ASSET_BYTES + 1);
		closeSync(fd);

		const result = await runCli(dgHome, port, [
			"stage",
			sourcePath,
			"--session",
			bootstrap.sessionId,
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("CHAT_MAX_ASSET_BYTES");
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(
			existsSync(join(getConfiguredAssetDirectory(paths), bootstrap.sessionId)),
		).toBe(false);
	});
});
