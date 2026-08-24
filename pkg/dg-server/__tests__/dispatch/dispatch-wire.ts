import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, isRecord } from "@dg/common";
import { runCli } from "../commands/cli-wire";
import {
	scratchDir,
	waitForValue,
	writeJsonFile,
} from "../utils/daemon-harness";

export function scratchScriptDir(): string {
	return scratchDir("dg-dispatch");
}

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

export async function publishManifest(
	dgHome: string,
	port: number,
	sessionId: string,
	entries: unknown[],
	scratchDir: string,
): Promise<void> {
	const path = writeJsonFile(scratchDir, `commands-${sessionId}.json`, entries);
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
	await new Promise((r) => setTimeout(r, 100));
}

export async function publishSubagents(
	dgHome: string,
	port: number,
	sessionId: string,
	names: string[],
	scratchDir: string,
): Promise<void> {
	const commandsPath = writeJsonFile(
		scratchDir,
		`commands-${sessionId}.json`,
		[],
	);
	const subagentsPath = writeJsonFile(
		scratchDir,
		`subagents-${sessionId}.json`,
		names,
	);
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

export async function waitForNthCommandResult(
	frames: unknown[],
	countBefore: number,
	timeoutMs = 3000,
): Promise<CommandResultFrame> {
	return waitForValue(
		() => {
			const all = frames.filter(isCommandResult);
			return all.length > countBefore ? all[countBefore] : undefined;
		},
		timeoutMs,
		`command-result #${countBefore + 1}`,
	);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function waitForProcessExit(
	pid: number,
	timeoutMs = 3000,
): Promise<void> {
	await waitForValue(
		() => (isProcessAlive(pid) ? undefined : true),
		timeoutMs,
		`pid ${pid} to exit`,
	);
}
