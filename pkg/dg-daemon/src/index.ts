#!/usr/bin/env bun

import {
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	type SessionRole,
} from "@dg/common";
import { Command } from "commander";
import { registerAgentCommands } from "./commands";
import { cmdServe, cmdStart, cmdStatus } from "./server/bootstrap";

const program = new Command();
program
	.name("dg-daemon")
	.description(
		"Loopback HTTP+WebSocket daemon hosting many chat sessions for dg:start.",
	)
	.showHelpAfterError();

registerAgentCommands(program);

program
	.command("start")
	.description("start (or reuse) the daemon and register a new chat session")
	.option("-w, --workset <label>", "workset label to attach to this session")
	.option("--orchestrator", "register this session with the orchestrator role")
	.option("-a, --agent-identity <name>", "agent identity to record")
	.option("--open", "open the bootstrap URL in the default browser")
	.action(
		async (opts: {
			workset?: string;
			orchestrator?: boolean;
			agentIdentity?: string;
			open?: boolean;
		}) => {
			const role: SessionRole = opts.orchestrator ? "orchestrator" : "agent";
			await cmdStart({
				workset: opts.workset,
				role,
				agentIdentity: opts.agentIdentity,
				open: opts.open,
			});
		},
	);

program
	.command("__serve", { hidden: true })
	.description(
		"internal: run the daemon in the foreground (never call directly)",
	)
	.action(async () => {
		await cmdServe();
	});

program
	.command("status")
	.description("report the live daemon's status, or that none is running")
	.action(async () => {
		await cmdStatus();
	});

program.parseAsync(process.argv).catch((err: unknown) => {
	console.error(`dg-daemon: ${describeError(err)}`);
	process.exit(err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE);
});
