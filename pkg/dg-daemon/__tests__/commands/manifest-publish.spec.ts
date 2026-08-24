import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { relative } from "node:path";
import {
	CHAT_MAX_MANIFEST_BYTES,
	CHAT_PROTOCOL_VERSION,
	validateChatFrame,
} from "@dg/common";
import {
	startWithSession as bootDaemonSession,
	cleanupDgHome,
	collectFrames,
	connectCli,
	freshTempDir,
	killDaemonByPidFile,
	sendConnectHandshake,
	waitForOpen,
	writeJsonFile,
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

const VALID_ENTRY = { label: "List files", argv: ["ls"], params: [] };

describe("dg-daemon manifest", () => {
	it("publishes the validated manifest, resolving a relative --commands path to absolute before sending", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = freshTempDir("dg-manifest-e2e");
		const manifestPath = writeJsonFile(scratchDir, "commands.json", [
			VALID_ENTRY,
		]);

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page);

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
		scratchDir = freshTempDir("dg-manifest-subagents");
		const manifestPath = writeJsonFile(scratchDir, "commands.json", [
			VALID_ENTRY,
		]);
		const subagentsPath = writeJsonFile(scratchDir, "subagents.json", [
			"reviewer",
			"planner",
		]);

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page);

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
		scratchDir = freshTempDir("dg-manifest-e2e-bad");
		const manifestPath = writeJsonFile(scratchDir, "bad.json", [
			{ command: "not allowed" },
		]);

		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page);
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
		await nextParsedMessage(page);
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
		await nextParsedMessage(page);
		const frames = collectFrames(page);

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
