#!/usr/bin/env bun

/**
 * dg-server — the loopback HTTP+WebSocket daemon behind `dg:start`. Thin
 * commander entry point; `__serve` is a hidden subcommand (see bootstrap.ts's
 * daemonize note), never invoked directly by a human.
 */

import type { SessionRole } from "@dg/common";
import { Command } from "commander";
import { cmdServe, cmdStart, cmdStatus } from "./server/bootstrap";
import { DgCliError, EXIT_GENERAL_FAILURE } from "./server/errors";

const program = new Command();
program
	.name("dg-server")
	.description(
		"Loopback HTTP+WebSocket daemon hosting many chat sessions for dg:start.",
	)
	.showHelpAfterError();

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
	const message = err instanceof Error ? err.message : String(err);
	console.error(`dg-server: ${message}`);
	process.exit(err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE);
});
