#!/usr/bin/env bun

import { DgCliError, describeError, EXIT_GENERAL_FAILURE } from "@dg/common";
import { Command } from "commander";
import { registerJobCommands } from "./commands/jobs";
import { cmdServe, cmdStatus } from "./server/bootstrap";

const program = new Command();
program
	.name("dg-daemon")
	.description(
		"Loopback HTTP+WebSocket daemon hosting many chat sessions for dg:start.",
	)
	.showHelpAfterError();

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

registerJobCommands(program);

program.parseAsync(process.argv).catch((err: unknown) => {
	console.error(`dg-daemon: ${describeError(err)}`);
	process.exit(err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE);
});
