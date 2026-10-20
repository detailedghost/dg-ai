#!/usr/bin/env bun

import {
	DgCliError,
	describeError,
	emitRedacted,
	EXIT_GENERAL_FAILURE,
	type SessionRole,
} from "@dg/common";
import { Command } from "commander";
import { registerAgentCommands } from "./commands";
import { registerMemoryCommands } from "./memory/commands";
import { registerPhoneFriendCommands } from "./phone-friend/commands";
import { claimWaitingSession } from "./attach";
import { cliNextStep } from "./next-step";
import { cmdStart } from "./start";
import {
	buildBootstrapUrl,
	isDaemonLive,
	readPidFile,
	resolveDgPaths,
	tryOpen,
} from "@dg/common/node";

const program = new Command();
program
	.name("dg-agent")
	.description(
		"CLI an agent drives the dg-daemon with — chat, assets, and session lifecycle.",
	)
	.showHelpAfterError();

registerAgentCommands(program);
registerMemoryCommands(program);
registerPhoneFriendCommands(program);

program
	.command("start")
	.description("start (or reuse) the daemon and register a new chat session")
	.option("-w, --workset <label>", "workset label to attach to this session")
	.option("--orchestrator", "register this session with the orchestrator role")
	.option("-a, --agent-identity <name>", "agent identity to record")
	.option("--open", "open the bootstrap URL in the default browser")
	.option("--fresh", "register a new session even if the extension is waiting")
	.option("-s, --session <id>", "claim this waiting session instead of creating one")
	.option(
		"--print-session-id",
		"print the session id, then the bootstrap URL",
	)
	.option(
		"--json",
		"print sessionId, port, and the bootstrap URL as one JSON object",
	)
	.action(
		async (opts: {
			workset?: string;
			orchestrator?: boolean;
			agentIdentity?: string;
			open?: boolean;
			fresh?: boolean;
			session?: string;
			printSessionId?: boolean;
			json?: boolean;
		}) => {
			const role: SessionRole = opts.orchestrator ? "orchestrator" : "agent";
			await cmdStart({
				workset: opts.workset,
				role,
				agentIdentity: opts.agentIdentity,
				open: opts.open,
				fresh: opts.fresh,
				sessionId: opts.session,
				printSessionId: opts.printSessionId,
				json: opts.json,
			});
		},
	);

program
	.command("attach")
	.description(
		"claim a session the extension created and is waiting on, instead of registering a new one",
	)
	.option("-s, --session <id>", "session id to claim")
	.option("--open", "open the bootstrap URL in the default browser")
	.action(async (opts: { session?: string; open?: boolean }) => {
		const paths = resolveDgPaths();
		const handle = readPidFile(paths);
		if (!handle || !(await isDaemonLive(handle))) {
			throw new DgCliError(
				"no daemon is running. Open the extension and start a session, or run dg-agent start.",
				EXIT_GENERAL_FAILURE,
			);
		}
		const claimed = await claimWaitingSession(
			handle.port,
			process.cwd(),
			"attach",
			opts.session,
		);
		if (!claimed) {
			throw new DgCliError(
				"no session is waiting. In the extension choose New session for CLI, or run dg-agent start.",
				EXIT_GENERAL_FAILURE,
			);
		}
		const url = buildBootstrapUrl(handle.port, claimed);
		console.error(cliNextStep("attached", claimed.sessionId));
		console.log(url);
		if (opts.open) await tryOpen(url);
	});

program.parseAsync(process.argv).catch((err: unknown) => {
	emitRedacted((line) => console.error(line), `dg-agent: ${describeError(err)}`);
	process.exit(err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE);
});
