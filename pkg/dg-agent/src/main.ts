import type { SessionRole } from "@dg/common";
import type { Command } from "commander";

export async function main(argv: readonly string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		process.stdout.write(`${process.env.DG_BUILD_VERSION ?? "dev"}\n`);
		return 0;
	}
	const [
		{ Command, CommanderError },
		{ DgCliError, describeError, emitRedacted, EXIT_GENERAL_FAILURE },
		{ registerAgentCommands, selectedSession },
		{ registerMemoryCommands },
		{ registerLazyPhoneCommands },
	] = await Promise.all([
		import("commander"),
		import("@dg/common"),
		import("./commands"),
		import("./memory/commands"),
		import("./phone/register"),
	]);
	const program = new Command();
	program
		.name("dg-agent")
		.description(
			"CLI an agent drives the dg-daemon with — chat, assets, and session lifecycle.",
		)
		.showHelpAfterError()
		.exitOverride();

	registerAgentCommands(program);
	registerMemoryCommands(program);
	registerLazyPhoneCommands(program);

	program
		.command("start")
		.description("start (or reuse) the daemon and register a new chat session")
		.option("-w, --workset <label>", "workset label to attach to this session")
		.option("--orchestrator", "register this session with the orchestrator role")
		.option("-a, --agent-identity <name>", "agent identity to record")
		.option("--open", "open the chat page in the default browser")
		.option("--ext", "require the dg-ai-extension for this skill; the chat page URL is the same as without it")
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
				printSessionId?: boolean;
				json?: boolean;
				ext?: boolean;
			}) => {
				const role: SessionRole = opts.orchestrator ? "orchestrator" : "agent";
				const { cmdStart } = await import("./start");
				await cmdStart({
					workset: opts.workset,
					role,
					agentIdentity: opts.agentIdentity,
					open: opts.open,
					printSessionId: opts.printSessionId,
					json: opts.json,
					ext: opts.ext,
				});
			},
		);

	program
		.command("pair")
		.description("pair this session with the browser extension")
		.argument("<code>", "6 digit code the extension popup shows")
		.action(async (code: string, _options: unknown, command: Command) => {
			const { cmdPair } = await import("./pair");
			await cmdPair({ code, sessionId: selectedSession(command) });
		});

	try {
		await program.parseAsync([...argv], { from: "user" });
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	} catch (err) {
		if (err instanceof CommanderError) return err.exitCode;
		emitRedacted((line) => console.error(line), `dg-agent: ${describeError(err)}`);
		return err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE;
	}
}
