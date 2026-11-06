import type { SessionRole } from "@dg/common";
import type { LayoutHooks } from "@dg/common/node/layout";
import type { Command } from "commander";

const SKIP = new Set(["phone __run"]);

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
		.option("--open", "open the chat page in the default browser")
		.option("--ext", "hand the session to the dg-ai-extension instead of the local page")
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
				ext?: boolean;
			}) => {
				const role: SessionRole = opts.orchestrator ? "orchestrator" : "agent";
				const { cmdStart } = await import("./start");
				await cmdStart({
					workset: opts.workset,
					role,
					agentIdentity: opts.agentIdentity,
					open: opts.open,
					fresh: opts.fresh,
					sessionId: opts.session,
					printSessionId: opts.printSessionId,
					json: opts.json,
					ext: opts.ext,
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
			const [{ buildBootstrapUrl, isDaemonLive, readPidFile, resolveDgPaths }, { claimWaitingSession }, { cliNextStep }, { openUrlOrHint }] =
				await Promise.all([import("@dg/common/node"), import("./attach"), import("./next-step"), import("./start")]);
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
			if (opts.open) await openUrlOrHint(url);
		});

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
