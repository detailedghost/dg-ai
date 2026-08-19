/**
 * The `manifest` CLI verb, over the wire — distinct from manifest-load.spec.ts's
 * pure-function unit tests. Covers: paths resolved absolute before sending,
 * and an invalid file publishing nothing observable to a listening page.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	validateChatFrame,
	validateSessionBootstrap,
} from "@dg/common";
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
	wsExtensionSocket,
} from "../utils/daemon-harness";
import { nextParsedMessage, runCli } from "./cli-wire";

let dgHome: string;
let scratchDir: string;

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

const VALID_ENTRY = { label: "List files", argv: ["ls"], params: [] };

describe("dg-server manifest", () => {
	it("publishes the validated manifest, resolving a relative --commands path to absolute before sending", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = mkdtempSync(join(tmpdir(), "dg-manifest-e2e-"));
		const manifestPath = join(scratchDir, "commands.json");
		writeFileSync(manifestPath, JSON.stringify([VALID_ENTRY]));

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // session-list

		// Run the CLI from a DIFFERENT cwd with a RELATIVE --commands path —
		// the CLI must resolve it against its own cwd, not the daemon's.
		const relativePath = relative(scratchDir, manifestPath);
		const result = await runCli(
			dgHome,
			port,
			[
				"manifest",
				"--session",
				bootstrap.sessionId,
				"--commands",
				relativePath,
			],
			{},
			{ cwd: scratchDir },
		);
		expect(result.exitCode).toBe(0);

		const frame = await nextParsedMessage(page);
		page.close();
		const validated = validateChatFrame(frame);
		expect(validated.type).toBe("manifest-publish");
		expect((validated as { commands: unknown[] }).commands).toEqual([
			VALID_ENTRY,
		]);
	});

	it("publishes nothing observable when the manifest file is invalid", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = mkdtempSync(join(tmpdir(), "dg-manifest-e2e-bad-"));
		const manifestPath = join(scratchDir, "bad.json");
		writeFileSync(manifestPath, JSON.stringify([{ command: "not allowed" }]));

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // session-list
		const frames = collectFrames(page);

		const result = await runCli(dgHome, port, [
			"manifest",
			"--session",
			bootstrap.sessionId,
			"--commands",
			manifestPath,
		]);

		expect(result.exitCode).not.toBe(0);
		await new Promise((r) => setTimeout(r, 300));
		expect(
			frames.some(
				(f) =>
					typeof f === "object" &&
					f !== null &&
					(f as { type?: string }).type === "manifest-publish",
			),
		).toBe(false);
		page.close();
	});
});
