/**
 * The `manifest` CLI verb, over the wire — distinct from manifest-load.spec.ts's
 * pure-function unit tests. Covers paths resolved absolute before sending, an
 * invalid file publishing nothing observable, and the same refusals driven
 * over a raw /cli socket — the CLI-side check is a fast local error only, never the boundary.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	CHAT_MAX_MANIFEST_BYTES,
	CHAT_PROTOCOL_VERSION,
	validateChatFrame,
	validateSessionBootstrap,
} from "@dg/common";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	connectCli,
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

	it("reads, validates, and publishes --subagents alongside --commands", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = mkdtempSync(join(tmpdir(), "dg-manifest-subagents-"));
		const manifestPath = join(scratchDir, "commands.json");
		writeFileSync(manifestPath, JSON.stringify([VALID_ENTRY]));
		const subagentsPath = join(scratchDir, "subagents.json");
		writeFileSync(subagentsPath, JSON.stringify(["reviewer", "planner"]));

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // session-list

		const result = await runCli(dgHome, port, [
			"manifest",
			"--session",
			bootstrap.sessionId,
			"--commands",
			manifestPath,
			"--subagents",
			subagentsPath,
		]);
		expect(result.exitCode).toBe(0);

		const frame = await nextParsedMessage(page);
		page.close();
		expect((frame as { subagents?: string[] }).subagents).toEqual([
			"reviewer",
			"planner",
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

	it("refuses a shell-escape entry published straight over a raw /cli socket, bypassing the CLI's own check entirely", async () => {
		const { port, bootstrap } = await startWithSession();

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // session-list
		const frames = collectFrames(page);

		const raw = await connectCli(port, bootstrap);
		raw.send(
			JSON.stringify({
				type: "cli-manifest-publish",
				commands: [
					{
						label: "shell-escape",
						params: [{ name: "cmd", type: "string" }],
						argv: ["bash", "-c", "{cmd}"],
					},
				],
			}),
		);
		await new Promise((r) => setTimeout(r, 300));
		raw.close();

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

	it("refuses a command manifest whose serialized size exceeds CHAT_MAX_MANIFEST_BYTES over a raw /cli socket", async () => {
		const { port, bootstrap } = await startWithSession();

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // session-list
		const frames = collectFrames(page);

		// Roughly double CHAT_MAX_MANIFEST_BYTES (64KB), safely under the 1MB
		// transport payload cap, so this exercises the manifest cap specifically.
		expect(CHAT_MAX_MANIFEST_BYTES).toBeLessThan(123_454);
		const raw = await connectCli(port, bootstrap);
		raw.send(
			JSON.stringify({
				type: "cli-manifest-publish",
				commands: [{ label: "x".repeat(123_454), argv: ["ls"], params: [] }],
			}),
		);
		await new Promise((r) => setTimeout(r, 300));
		raw.close();

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
