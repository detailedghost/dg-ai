import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	type CliRecvResult,
	DgCliError,
	describeError,
	EXIT_RECV_SESSION_CLOSED,
	EXIT_RECV_TIMEOUT,
	isRecord,
	parseNonNegativeInteger,
	type SessionBootstrap,
} from "@dg/common";
import {
	CliClient,
	frameEnvelope,
	loadManifestFile,
	loadSubagentManifestFile,
	postAsset,
	readAssetSourceFile,
	mintPageCode,
	resolveCliSession,
	resolveManifestForPublish,
	writeStderr,
	writeStdout,
} from "@dg/common/node";
import type { Command } from "commander";
import { registerOverwatchCommands } from "./overwatch";
import { tryOpenAgentUrl } from "./start";

const DEFAULT_RECV_TIMEOUT_MS = 30_000;

export function selectedSession(command: Command): string | undefined {
	return command.optsWithGlobals<{ session?: string }>().session;
}

function parseTimeout(value: string): number {
	return parseNonNegativeInteger("--timeout", value);
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
	return CliClient.connect(await resolveCliSession(selectedSession(command)));
}

export async function localBootstrap(command: Command): Promise<SessionBootstrap> {
	try {
		return await resolveCliSession(selectedSession(command));
	} catch (error) {
		throw new DgCliError(
			`${describeError(error).replace(/\.+$/, "")}. Run dg-agent start first.`,
		);
	}
}

export type RecvCommandClient = Pick<
	CliClient,
	"request" | "send" | "close"
>;

export type RecvCommandDependencies = {
	connect(command: Command): Promise<RecvCommandClient>;
	write(value: string): Promise<void>;
};

export function registerRecvCommand(
	program: Command,
	dependencies: RecvCommandDependencies,
): void {
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
				const client = await dependencies.connect(command);
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
					await dependencies.write(`${JSON.stringify(result)}\n`);
					if (result.outcome === "delivered") {
						const claimId = result.message.claimId;
						if (typeof claimId !== "string") {
							throw new DgCliError(
								"dg-daemon delivered a message without a claimId",
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
}

export function registerAgentCommands(program: Command): void {
	program.option(
		"-s, --session <id>",
		"session id (otherwise resolve the sole realpath-matching cwd session)",
	);

	registerOverwatchCommands(program.command("overwatch"), {
		connect: connectFor,
		write: writeStdout,
		writeError: writeStderr,
		tryOpen: tryOpenAgentUrl,
		mintPageCode,
		localBootstrap,
	});

	registerRecvCommand(program, { connect: connectFor, write: writeStdout });

	program
		.command("send")
		.description("send one complete agent message")
		.argument("<body>", "message body")
		.option(
			"--to <identity>",
			"address the message to an agent identity instead of the human",
		)
		.action(
			async (body: string, options: { to?: string }, command: Command) => {
				const client = await connectFor(command);
				client.send({
					type: "cli-send",
					body,
					...(options.to ? { to: options.to } : {}),
				});
				client.close();
			},
		);

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
		.argument(
			"[command...]",
			"command to run with DG_SESSION_ID set to the new session; put it after --",
		)
		.option("--workset <label>", "workset label for the new session")
		.option("--orchestrator", "give the new session the orchestrator role")
		.option(
			"--agent-identity <name>",
			"bind the spawned session to a different agent identity",
		)
		.action(
			async (
				argv: string[],
				options: {
					workset?: string;
					orchestrator?: boolean;
					agentIdentity?: string;
				},
				command: Command,
			) => {
				const client = await connectFor(command);
				let sessionId: string;
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
					sessionId = result.newSession.sessionId;
					if (argv.length === 0) {
						await writeStdout(`${JSON.stringify({ sessionId })}\n`);
					}
				} finally {
					client.close();
				}
				if (argv.length === 0) return;
				const child = Bun.spawn(argv, {
					env: { ...process.env, DG_SESSION_ID: sessionId },
					stdin: "inherit",
					stdout: "inherit",
					stderr: "inherit",
				});
				process.exitCode = await child.exited;
			},
		);

	program
		.command("mcp")
		.description("serve the dg tools of the agent's tabs as an MCP server on stdio")
		.action(async (_options: unknown, command: Command) => {
			const session = await resolveCliSession(selectedSession(command));
			const [{ StdioServerTransport }, { connectCliLink }, { createDgMcpServer }] =
				await Promise.all([
					import("@modelcontextprotocol/sdk/server/stdio.js"),
					import("./mcp/link"),
					import("./mcp/server"),
				]);
			const server = createDgMcpServer({
				connect: () => connectCliLink(session),
				now: Date.now,
			});
			const closed = new Promise<void>((resolve) => {
				const previous = server.onclose;
				server.onclose = () => {
					previous?.();
					resolve();
				};
			});
			process.stdin.once("end", () => void server.close());
			await server.connect(new StdioServerTransport());
			await closed;
		});

	program
		.command("stage")
		.description("stage an asset for later presentation")
		.argument("<path>", "asset file path")
		.action(async (path: string, _options: unknown, command: Command) => {
			const source = realpathSync(resolve(path));
			const session = await resolveCliSession(selectedSession(command));
			const filename = basename(source);
			const bytes = readAssetSourceFile(source);

			const assetId = await postAsset(session, filename, bytes);
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
