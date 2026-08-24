import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, isRecord } from "@dg/common";
import {
	loadManifestFile,
	loadSubagentManifestFile,
	resolveManifestForPublish,
} from "@dg/common/node";
import {
	connectCli,
	scratchDir,
	send,
	sessionCredentials,
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
	const commands = resolveManifestForPublish(loadManifestFile(path));
	const ws = await connectCli(port, sessionCredentials(dgHome, sessionId));
	send(ws, { type: "cli-manifest-publish", commands });
	await new Promise((r) => setTimeout(r, 100));
	ws.close();
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
	const commands = resolveManifestForPublish(loadManifestFile(commandsPath));
	const subagents = loadSubagentManifestFile(subagentsPath);
	const ws = await connectCli(port, sessionCredentials(dgHome, sessionId));
	send(ws, { type: "cli-manifest-publish", commands, subagents });
	await new Promise((r) => setTimeout(r, 100));
	ws.close();
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
