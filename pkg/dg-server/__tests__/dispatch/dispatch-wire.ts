/**
 * Shared helpers for slice 8's dispatch test suite, sibling to (and reusing)
 * ../commands/cli-wire.ts and ../utils/daemon-harness.ts rather than a second
 * copy of their subprocess/socket plumbing.
 *
 * command-invocation/command-result carry no correlation id (not ratified by
 * any slice), so every test here either keeps at most one invocation in
 * flight at a time, or — where several ARE deliberately concurrent — asserts
 * on counts/predicates over the collected frame array rather than pairing a
 * specific request to a specific reply. See deferrals for the [SPEC] gap
 * this works around.
 */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, isRecord } from "@dg/common";
import { runCli } from "../commands/cli-wire";

export function scratchScriptDir(): string {
	return mkdtempSync(join(tmpdir(), "dg-dispatch-test-"));
}

/** Writes an executable #!/bin/sh script — argv[0] is the file's own path, never "sh"/"bash" literally. */
export function writeExecutableScript(
	dir: string,
	name: string,
	body: string,
): string {
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

export type DispatchCredentials = { sessionId: string; token: string };

/** Publishes a command manifest for one session via the already-shipped `manifest` CLI verb. */
export async function publishManifest(
	dgHome: string,
	port: number,
	sessionId: string,
	entries: unknown[],
	scratchDir: string,
): Promise<void> {
	const path = join(scratchDir, `commands-${sessionId}.json`);
	writeFileSync(path, JSON.stringify(entries));
	const result = await runCli(dgHome, port, [
		"manifest",
		"--session",
		sessionId,
		"--commands",
		path,
	]);
	if (result.exitCode !== 0) {
		throw new Error(`manifest publish failed: ${result.stderr}`);
	}
	// Publish is fire-and-forget over /cli, broadcast after the daemon's own
	// 25ms delay — give it room to land before a test sends its next frame.
	await new Promise((r) => setTimeout(r, 100));
}

/** Publishes a session's subagent list (with an empty command manifest) for @ mention resolution. */
export async function publishSubagents(
	dgHome: string,
	port: number,
	sessionId: string,
	names: string[],
	scratchDir: string,
): Promise<void> {
	const commandsPath = join(scratchDir, `commands-${sessionId}.json`);
	const subagentsPath = join(scratchDir, `subagents-${sessionId}.json`);
	writeFileSync(commandsPath, JSON.stringify([]));
	writeFileSync(subagentsPath, JSON.stringify(names));
	const result = await runCli(dgHome, port, [
		"manifest",
		"--session",
		sessionId,
		"--commands",
		commandsPath,
		"--subagents",
		subagentsPath,
	]);
	if (result.exitCode !== 0) {
		throw new Error(`subagent publish failed: ${result.stderr}`);
	}
	await new Promise((r) => setTimeout(r, 100));
}

export function commandInvocationFrame(
	credentials: DispatchCredentials,
	commandLabel: string,
	params: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		type: "command-invocation",
		sessionId: credentials.sessionId,
		token: credentials.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		commandLabel,
		params,
	});
}

export type CommandResultFrame = {
	type: "command-result";
	ok: boolean;
	output?: string;
	error?: string;
};

export function isCommandResult(value: unknown): value is CommandResultFrame {
	return (
		isRecord(value) &&
		value.type === "command-result" &&
		typeof value.ok === "boolean"
	);
}

/** Polls `frames` for the (n+1)th command-result, for callers firing several requests on one socket with no correlation id. */
export async function waitForNthCommandResult(
	frames: unknown[],
	countBefore: number,
	timeoutMs = 3000,
): Promise<CommandResultFrame> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const all = frames.filter(isCommandResult);
		if (all.length > countBefore) return all[countBefore];
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for command-result #${countBefore + 1}`);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Polls until `pid` is no longer signalable, or throws after timeoutMs — proves a real kill, not just a claimed one. */
export async function waitForProcessExit(
	pid: number,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`pid ${pid} was still alive after ${timeoutMs}ms`);
}
