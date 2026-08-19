/**
 * spawn and close ride the ALREADY-ratified session-create / session-close
 * ChatFrame types over the CLI's own /cli connection (its header-captured
 * capability supplies the token) — no new wire shape needed for either.
 *
 * stage is scoped narrowly here: this pass tests only the filesystem +
 * CLI-output contract (a staged file lands under the resolved assets dir and
 * the CLI prints an id). Whether `stage` also inserts an `assets` table row
 * is left to the manifest [SPEC] deferral — the schema's write-path for
 * asset bytes/filenames is explicitly "owed" to slice 9 in Code Structure.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	sendConnectHandshake,
	waitForHealth,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";
import { nextParsedMessage, runCli } from "./cli-wire";

let dgHome: string;
let scratchDir: string;

/** Recursively checks whether any file under `dir` contains `needle`'s bytes. */
function findFileContaining(dir: string, needle: Buffer): boolean {
	if (!existsSync(dir)) return false;
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			if (findFileContaining(full, needle)) return true;
		} else if (readFileSync(full).includes(needle)) {
			return true;
		}
	}
	return false;
}

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

async function startWithSession() {
	dgHome = freshDgHome();
	const port = allocatePort();
	const result = await runStart(dgHome, port);
	await waitForHealth(port);
	const bootstrap = validateSessionBootstrap(
		decodeChatMarker(extractUrl(result.stdout)),
	);
	return { port, bootstrap };
}

describe("dg-server spawn", () => {
	it("registers a new session through slice 2's session-create handler, and it shows up in the session list", async () => {
		const { port, bootstrap } = await startWithSession();
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // initial session-list (one session)
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
		// The ratified session-create frame inherits agentIdentity from the
		// requester (frame-handlers.ts's handleSessionCreate) — spawn cannot
		// set a distinct identity via this frame shape. See deferrals.
		expect(spawned?.agentIdentity).toBe(bootstrap.agentIdentity);
		page.close();
	});
});

describe("dg-server close", () => {
	it("emits the session-close frame — a listening page sees session-closed", async () => {
		const { port, bootstrap } = await startWithSession();
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // initial session-list
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
	it("copies the staged file's bytes somewhere under the resolved assets directory and prints an asset id", async () => {
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
		expect(existsSync(paths.assetsDir)).toBe(true);
		expect(findFileContaining(paths.assetsDir, marker)).toBe(true);
	});
});
