import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../commands/cli-wire";
import {
	startWithSession as bootDaemonSession,
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectPage,
	killDaemonByPidFile,
	waitForValue,
} from "../utils/daemon-harness";
import {
	commandInvocationFrame,
	type DispatchCredentials,
	isCommandResult,
	publishManifest,
	scratchScriptDir,
	writeExecutableScript,
} from "./dispatch-wire";

let dgHome: string;
let scratchDir: string;
const openSockets: WebSocket[] = [];

afterEach(() => {
	killDaemonByPidFile(dgHome);
	closeSockets(openSockets);
	cleanupDgHome(dgHome);
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

async function startWithSession(extraEnv: Record<string, string> = {}) {
	const started = await bootDaemonSession(extraEnv);
	dgHome = started.dgHome;
	return started;
}

async function connectedPage(
	port: number,
	credentials: DispatchCredentials,
): Promise<WebSocket> {
	const page = await connectPage(port, credentials);
	openSockets.push(page);
	return page;
}

describe("$ command-invocation: happy path", () => {
	it("executes a published manifest entry and returns its stdout as a successful command-result", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[
				{
					label: "Echo",
					argv: ["echo", "{msg}"],
					params: [{ name: "msg", type: "string" }],
				},
			],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		page.send(
			commandInvocationFrame(bootstrap, "Echo", { msg: "hello-dispatch" }),
		);

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			5000,
			"command-result",
		);
		expect(result.ok).toBe(true);
		expect(result.output).toContain("hello-dispatch");
		page.close();
	}, 10_000);

	it("keeps a shell-metacharacter param value entirely literal in the executed output", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[
				{
					label: "Echo",
					argv: ["echo", "{msg}"],
					params: [{ name: "msg", type: "string" }],
				},
			],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		const payload = "$(id); rm -rf /tmp/should-not-run; `whoami`";
		page.send(commandInvocationFrame(bootstrap, "Echo", { msg: payload }));

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			5000,
			"command-result",
		);
		expect(result.ok).toBe(true);
		expect(result.output).toContain(payload);
		page.close();
	}, 10_000);
});

describe("$ command-invocation: manifest scoping", () => {
	it("refuses a commandLabel not present in the session's manifest, and never runs the unrelated entry that IS listed", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		const canaryPath = join(scratchDir, "canary.txt");
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[{ label: "Canary", argv: ["touch", canaryPath], params: [] }],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		page.send(commandInvocationFrame(bootstrap, "NotPublished"));

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			3000,
			"command-result",
		);
		expect(result.ok).toBe(false);
		expect(existsSync(canaryPath)).toBe(false);
		page.close();
	}, 10_000);

	it("refuses a commandLabel published only for a different session, even when the requester presents its own valid token", async () => {
		const { port, bootstrap: a } = await startWithSession();
		scratchDir = scratchScriptDir();
		const spawned = await runCli(dgHome, port, [
			"spawn",
			"--session",
			a.sessionId,
			"--agent-identity",
			"session-b",
		]);
		expect(spawned.exitCode).toBe(0);
		const b = JSON.parse(spawned.stdout.trim()) as DispatchCredentials;

		await publishManifest(
			dgHome,
			port,
			a.sessionId,
			[{ label: "OnlyA", argv: ["echo", "only-a-ran"], params: [] }],
			scratchDir,
		);
		await publishManifest(
			dgHome,
			port,
			b.sessionId,
			[{ label: "OnlyB", argv: ["echo", "only-b-ran"], params: [] }],
			scratchDir,
		);

		const page = await connectedPage(port, b);
		const frames = collectFrames(page);

		page.send(commandInvocationFrame(b, "OnlyA"));
		const refusal = await waitForValue(
			() => frames.find(isCommandResult),
			3000,
			"refusal for session A's command",
		);
		expect(refusal.ok).toBe(false);

		page.send(commandInvocationFrame(b, "OnlyB"));
		const success = await waitForValue(
			() => {
				const all = frames.filter(isCommandResult);
				return all.length > 1 ? all[1] : undefined;
			},
			3000,
			"success for session B's own command",
		);
		expect(success.ok).toBe(true);
		expect(success.output).toContain("only-b-ran");
		page.close();
	}, 15_000);
});

describe("$ command-invocation: argument safety", () => {
	it("refuses a dash-prefixed param value rather than letting the target interpret it as an option", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[
				{
					label: "Echo",
					argv: ["echo", "{msg}"],
					params: [{ name: "msg", type: "string" }],
				},
			],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		page.send(commandInvocationFrame(bootstrap, "Echo", { msg: "--version" }));

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			3000,
			"command-result",
		);
		expect(result.ok).toBe(false);
		expect(result.error ?? "").toMatch(/dash|leading -|option/i);
		expect(result.output).toBeUndefined();
		page.close();
	}, 10_000);
});

describe("$ command-invocation: environment isolation", () => {
	it("never lets a secret present in the daemon's own environment appear in captured output", async () => {
		const secret = "sekrit-value-793214";
		const { port, bootstrap } = await startWithSession({
			DG_TEST_SECRET: secret,
		});
		scratchDir = scratchScriptDir();
		const scriptPath = writeExecutableScript(scratchDir, "dump-env.sh", "env");
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[{ label: "DumpEnv", argv: [scriptPath], params: [] }],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		page.send(commandInvocationFrame(bootstrap, "DumpEnv"));

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			3000,
			"command-result",
		);
		expect(result.ok).toBe(true);
		expect(result.output ?? "").not.toContain(secret);
		expect(result.output ?? "").not.toContain("DG_TEST_SECRET");
		page.close();
	}, 10_000);
});

describe("$ command-invocation: failure reasons", () => {
	it("yields a distinct failure reason for a non-zero exit", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[{ label: "Fail", argv: ["false"], params: [] }],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		page.send(commandInvocationFrame(bootstrap, "Fail"));

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			3000,
			"command-result",
		);
		expect(result.ok).toBe(false);
		expect(result.error ?? "").toMatch(/exit|status|code/i);
		page.close();
	}, 10_000);

	it("re-resolves argv[0] at invocation and refuses by name when the binary vanished after publish, never reaching a spawn", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		const scriptPath = writeExecutableScript(
			scratchDir,
			"ephemeral.sh",
			"echo should-not-run",
		);
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[{ label: "Ephemeral", argv: [scriptPath], params: [] }],
			scratchDir,
		);
		rmSync(scriptPath);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		page.send(commandInvocationFrame(bootstrap, "Ephemeral"));

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			3000,
			"command-result",
		);
		expect(result.ok).toBe(false);
		expect(result.error ?? "").toBe(
			`command "Ephemeral" executable "${scriptPath}" does not resolve on PATH`,
		);
		expect(result.output ?? "").not.toContain("should-not-run");
		page.close();
	}, 10_000);
});
