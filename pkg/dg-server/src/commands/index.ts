import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { extname, resolve } from "node:path";
import { isRecord } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import type { Command } from "commander";
import {
	loadManifestFile,
	loadSubagentManifestFile,
	resolveManifestForPublish,
} from "../manifest/load";
import {
	DgCliError,
	EXIT_RECV_SESSION_CLOSED,
	EXIT_RECV_TIMEOUT,
} from "../server/errors";
import { CliClient, frameEnvelope, resolveCliSession } from "./client";
import type { CliRecvResult } from "./wire";

const DEFAULT_RECV_TIMEOUT_MS = 30_000;

function selectedSession(command: Command): string | undefined {
	return command.optsWithGlobals<{ session?: string }>().session;
}

function parseTimeout(value: string): number {
	const timeoutMs = Number(value);
	if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
		throw new DgCliError("--timeout must be a non-negative integer");
	}
	return timeoutMs;
}

function writeStdout(value: string): Promise<void> {
	return new Promise((resolveWrite, reject) => {
		process.stdout.write(value, (error) => {
			if (error) reject(error);
			else resolveWrite();
		});
	});
}

function isRecvResult(value: unknown): value is CliRecvResult {
	if (!isRecord(value)) return false;
	const result = value;
	if (result.type !== "cli-recv-result") return false;
	if (result.outcome === "delivered") {
		return isRecord(result.message);
	}
	return (
		result.outcome === "empty" ||
		result.outcome === "timeout" ||
		result.outcome === "closed"
	);
}

function isSessionPending(value: unknown): value is {
	type: "session-pending";
	newSession: { sessionId: string; token: string };
} {
	if (!isRecord(value)) return false;
	const frame = value;
	if (frame.type !== "session-pending" || !isRecord(frame.newSession)) {
		return false;
	}
	const session = frame.newSession;
	return (
		typeof session.sessionId === "string" && typeof session.token === "string"
	);
}

function isSessionClosed(value: unknown): value is { type: "session-closed" } {
	return isRecord(value) && value.type === "session-closed";
}

async function connectFor(command: Command): Promise<CliClient> {
	return CliClient.connect(resolveCliSession(selectedSession(command)));
}

export function registerAgentCommands(program: Command): void {
	program.option(
		"-s, --session <id>",
		"session id (otherwise resolve the sole realpath-matching cwd session)",
	);

	program
		.command("recv")
		.description("receive the next queued human message")
		.option("--block", "wait until a message arrives")
		.option(
			"--timeout <ms>",
			"blocking receive timeout in milliseconds",
			String(DEFAULT_RECV_TIMEOUT_MS),
		)
		.action(
			async (
				options: { block?: boolean; timeout: string },
				command: Command,
			) => {
				const timeoutMs = parseTimeout(options.timeout);
				const client = await connectFor(command);
				try {
					const result = await client.request(
						{
							type: "cli-recv",
							block: options.block ?? false,
							...(options.block ? { timeoutMs } : {}),
						},
						isRecvResult,
						timeoutMs + 2_000,
					);
					await writeStdout(`${JSON.stringify(result)}\n`);
					if (result.outcome === "delivered") {
						const claimId = result.message.claimId;
						if (typeof claimId !== "string") {
							throw new DgCliError(
								"dg-server delivered a message without a claimId",
							);
						}
						client.send({ type: "cli-ack", claimId });
						return;
					}
					if (result.outcome === "timeout") {
						throw new DgCliError("recv timed out", EXIT_RECV_TIMEOUT);
					}
					if (result.outcome === "closed") {
						throw new DgCliError(
							"session closed while recv was blocked",
							EXIT_RECV_SESSION_CLOSED,
						);
					}
				} finally {
					client.close();
				}
			},
		);

	program
		.command("send")
		.description("send one complete agent message")
		.argument("<body>", "message body")
		.action(async (body: string, _options: unknown, command: Command) => {
			const client = await connectFor(command);
			client.send({ type: "cli-send", body });
			client.close();
		});

	program
		.command("progress")
		.description("publish an explicit running or awaiting-input state")
		.requiredOption("--state <state>", "running or awaiting-input")
		.action(async (options: { state: string }, command: Command) => {
			if (options.state !== "running" && options.state !== "awaiting-input") {
				throw new DgCliError('--state must be "running" or "awaiting-input"');
			}
			const client = await connectFor(command);
			client.send({ type: "cli-progress", state: options.state });
			client.close();
		});

	program
		.command("spawn")
		.description("spawn another background chat session")
		.option("--workset <label>", "workset label for the new session")
		.option("--orchestrator", "give the new session the orchestrator role")
		.option(
			"--agent-identity <name>",
			"bind the spawned session to a different agent identity",
		)
		.action(
			async (
				options: {
					workset?: string;
					orchestrator?: boolean;
					agentIdentity?: string;
				},
				command: Command,
			) => {
				const client = await connectFor(command);
				try {
					const result = await client.request(
						{
							type: "session-create",
							...frameEnvelope(client.session),
							role: options.orchestrator ? "orchestrator" : "agent",
							...(options.workset ? { workset: options.workset } : {}),
							...(options.agentIdentity
								? { agentIdentity: options.agentIdentity }
								: {}),
						},
						isSessionPending,
						5_000,
					);
					await writeStdout(`${JSON.stringify(result.newSession)}\n`);
				} finally {
					client.close();
				}
			},
		);

	program
		.command("stage")
		.description("stage an asset for later presentation")
		.argument("<path>", "asset file path")
		.action(async (path: string, _options: unknown, command: Command) => {
			const source = realpathSync(resolve(path));
			const session = resolveCliSession(selectedSession(command));
			const client = await CliClient.connect(session);
			client.close();
			const assetId = randomUUID();
			const paths = resolveDgPaths();
			const sessionDir = `${paths.assetsDir}/${session.sessionId}`;
			mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
			copyFileSync(source, `${sessionDir}/${assetId}${extname(source)}`);
			await writeStdout(`${assetId}\n`);
		});

	program
		.command("close")
		.description("close a chat session")
		.action(async (_options: unknown, command: Command) => {
			const client = await connectFor(command);
			try {
				await client.request(
					{
						type: "session-close",
						...frameEnvelope(client.session),
					},
					isSessionClosed,
					5_000,
				);
			} finally {
				client.close();
			}
		});

	program
		.command("manifest")
		.description("publish command and subagent manifests")
		.requiredOption("--commands <path>", "command manifest JSON path")
		.option("--subagents <path>", "subagent manifest JSON path")
		.action(
			async (
				options: { commands: string; subagents?: string },
				command: Command,
			) => {
				const commandsPath = resolve(options.commands);
				const commands = resolveManifestForPublish(
					loadManifestFile(commandsPath),
				);
				const subagents = options.subagents
					? loadSubagentManifestFile(resolve(options.subagents))
					: undefined;
				const client = await connectFor(command);
				client.send({
					type: "cli-manifest-publish",
					commands,
					...(subagents ? { subagents } : {}),
				});
				client.close();
			},
		);
}
