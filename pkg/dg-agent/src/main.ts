import type { SessionRole } from "@dg/common";
import type { LayoutHooks } from "@dg/common/node/layout";
import type { Command } from "commander";

const SKIP = new Set(["phone listen"]);

const topLevelName = (command: Command): string => (command.parent?.parent ? topLevelName(command.parent) : command.name());

export function hooksFor(action: Command): LayoutHooks {
	const hooks: LayoutHooks = {
		load: async () => {
			const { phoneLayoutHooks } = await import("./layout-hooks");
			const { "phone.verify": verify, "phone.stop": stop } = phoneLayoutHooks();
			Object.assign(hooks, { "phone.verify": verify }, topLevelName(action) === "phone" ? { "phone.stop": stop } : {});
		},
	};
	return hooks;
}

export async function main(argv: readonly string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		process.stdout.write(`${process.env.DG_BUILD_VERSION ?? "dev"}\n`);
		return 0;
	}
	const [
		{ Command, CommanderError },
		{ DgCliError, describeError, emitRedacted, EXIT_GENERAL_FAILURE },
		{ registerAgentCommands },
		{ registerMemoryCommands },
		{ registerLazyPhoneCommands },
		{ ensureLayout },
		{ installLayoutPreAction },
	] = await Promise.all([
		import("commander"),
		import("@dg/common"),
		import("./commands"),
		import("./memory/commands"),
		import("./phone/register"),
		import("@dg/common/node/layout"),
		import("@dg/common/node/layout-preaction"),
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
		.option("--open", "open the chat page in the default browser, paired through a one-time code")
		.option("--ext", "accepted for skills that require the dg-ai-extension; behaves like the default")
		.option("--print-session-id", "print only the session id")
		.option(
			"--json",
			"print sessionId, port, and extensionLinked as one JSON object",
		)
		.action(
			async (opts: {
				workset?: string;
				orchestrator?: boolean;
				agentIdentity?: string;
				open?: boolean;
				printSessionId?: boolean;
				json?: boolean;
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
				});
			},
		);

	installLayoutPreAction(program, {
		skip: SKIP,
		hooksFor,
		ensure: ensureLayout,
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
