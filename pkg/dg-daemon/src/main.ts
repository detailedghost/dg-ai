import {
	DgCliError,
	describeError,
	emitRedacted,
	EXIT_GENERAL_FAILURE,
	forever,
} from "@dg/common";
import { Command, CommanderError } from "commander";
import { registerJobCommands } from "./commands/jobs";
import { registerOriginCommands } from "./commands/origin";
import { registerPairCommand } from "./commands/pair";
import { registerSessionCommands } from "./commands/sessions";
import { registerServiceCommands } from "./commands/service";
import { cmdServe, cmdStatus } from "./server/bootstrap";

export async function main(argv: readonly string[]): Promise<number> {
	const program = new Command();
	program
		.name("dg-daemon")
		.description(
			"Loopback HTTP+WebSocket daemon hosting many chat sessions for dg:start.",
		)
		.showHelpAfterError()
		.exitOverride();

	program
		.command("__serve", { hidden: true })
		.description(
			"internal: run the daemon in the foreground (never call directly)",
		)
		.action(async () => {
			if ((await cmdServe()) === "serving") await forever();
		});

	program
		.command("status")
		.description("report the live daemon's status, or that none is running")
		.action(async () => {
			await cmdStatus();
		});

	registerJobCommands(program);
	registerOriginCommands(program);
	registerPairCommand(program);
	registerSessionCommands(program);
	registerServiceCommands(program);

	try {
		await program.parseAsync([...argv], { from: "user" });
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	} catch (err) {
		if (err instanceof CommanderError) return err.exitCode;
		emitRedacted((line) => console.error(line), `dg-daemon: ${describeError(err)}`);
		return err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE;
	}
}
