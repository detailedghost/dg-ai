import type { CompletionNode } from "@dg/common/completion";
import type { LayoutHooks } from "@dg/common/node/layout";
import type { Command } from "commander";

export const SKIP = new Set(["status", "completion", "autostart status"]);

type HookSeams = { platform?: NodeJS.Platform };

export function hooksFor(commandName: string, seams: HookSeams = {}): LayoutHooks {
	if (commandName !== "serve") return {};
	const hooks: LayoutHooks = {
		load: async () => {
			const { daemonLayoutHooks } = await import("./layout-hooks");
			Object.assign(hooks, daemonLayoutHooks({ platform: seams.platform }));
		},
	};
	return hooks;
}

async function afterLayout(action: Command): Promise<void> {
	if (action.name() === "serve") await afterServeLayout();
}

async function afterServeLayout(): Promise<void> {
	const [{ daemonLayoutHooks }, { resolveDgPaths }, { assertNotBlocked }] = await Promise.all([
		import("./layout-hooks"),
		import("@dg/common/node/dg-paths"),
		import("@dg/common/node/layout"),
	]);
	const paths = resolveDgPaths();
	assertNotBlocked(paths, "daemon");
	await daemonLayoutHooks().keychainMove(paths);
}

async function runServe(): Promise<void> {
	const [{ cmdServe }, { forever }] = await Promise.all([import("./server/bootstrap"), import("@dg/common/async")]);
	if ((await cmdServe()) === "serving") await forever();
}

/** Runs `dg daemon serve` without commander, the other commands or the completion code. */
async function serveWithoutProgram(): Promise<void> {
	const [{ ensureLayout }, { resolveDgPaths }] = await Promise.all([import("@dg/common/node/layout"), import("@dg/common/node/dg-paths")]);
	await ensureLayout(resolveDgPaths(), hooksFor("serve"));
	await afterServeLayout();
	await runServe();
}

async function failure(err: unknown): Promise<number> {
	const [{ DgCliError, describeError, EXIT_GENERAL_FAILURE }, { emitRedacted }] = await Promise.all([
		import("@dg/common/errors"),
		import("@dg/common/redact"),
	]);
	emitRedacted(
		(line) => console.error(line),
		`dg daemon: ${describeError(err)}`,
	);
	return err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE;
}

const exitCode = (): number => (typeof process.exitCode === "number" ? process.exitCode : 0);

/** The dg daemon program with every command registered and nothing parsed. */
export async function buildProgram(): Promise<Command> {
	const [
		{ Command },
		{ registerJobCommands },
		{ registerOriginCommands },
		{ registerSessionCommands },
		{ registerServiceCommands },
		{ registerCompletionCommand },
	] = await Promise.all([
		import("commander"),
		import("./commands/jobs"),
		import("./commands/origin"),
		import("./commands/sessions"),
		import("./commands/service"),
		import("@dg/common/completion"),
	]);
	const program = new Command();
	program
		.name("dg daemon")
		.description(
			"Loopback HTTP+WebSocket daemon hosting many chat sessions for dg:start.",
		)
		.showHelpAfterError()
		.exitOverride();

	program
		.command("serve")
		.description("Run the daemon in the foreground; dg starts this for you")
		.action(runServe);

	program
		.command("status")
		.description("report the live daemon's status, or that none is running")
		.action(async () => {
			const { cmdStatus } = await import("./server/bootstrap");
			await cmdStatus();
		});

	program
		.command("start")
		.description("start the daemon in the background, or report the live one")
		.option("--json", "print one JSON line")
		.action(async (options: { json?: boolean }) => {
			const { cmdStart } = await import("./commands/start");
			await cmdStart(options);
		});

	program
		.command("stop")
		.description("stop the daemon and its services")
		.option("--force", "kill the daemon and each service process tree at once")
		.action(async (options: { force?: boolean }) => {
			const { cmdStop } = await import("./commands/stop");
			await cmdStop(options);
		});

	program
		.command("restart")
		.description("stop the daemon, then start it again")
		.option("--force", "kill the daemon and each service process tree at once")
		.action(async (options: { force?: boolean }) => {
			const { cmdRestart } = await import("./commands/stop");
			await cmdRestart(options);
		});

	const autostart = program
		.command("autostart")
		.description("start the daemon at login through the service manager");
	autostart
		.command("install")
		.description("install and start the login unit")
		.action(async () => {
			const { cmdAutostartInstall } = await import("./commands/autostart");
			await cmdAutostartInstall();
		});
	autostart
		.command("remove")
		.description("disable and remove the login unit")
		.action(async () => {
			const { cmdAutostartRemove } = await import("./commands/autostart");
			await cmdAutostartRemove();
		});
	autostart
		.command("status")
		.description("report whether the login unit is installed")
		.option("--json", "print one JSON line")
		.action(async (options: { json?: boolean }) => {
			const { cmdAutostartStatus } = await import("./commands/autostart");
			await cmdAutostartStatus(options);
		});

	registerJobCommands(program);
	registerOriginCommands(program);
	registerSessionCommands(program);
	registerServiceCommands(program);
	registerCompletionCommand(program);
	return program;
}

export async function main(argv: readonly string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		const { buildVersion } = await import("@dg/common/build-version");
		process.stdout.write(`${buildVersion()}\n`);
		return 0;
	}
	if (argv[0] === "__complete") {
		const [{ printCompletions }, { default: tree }] = await Promise.all([
			import("@dg/common/completion"),
			import("./completion-tree.json", { with: { type: "json" } }),
		]);
		return printCompletions(tree as CompletionNode, argv.slice(1));
	}
	if (argv.length === 1 && argv[0] === "serve") {
		try {
			await serveWithoutProgram();
			return exitCode();
		} catch (err) {
			return failure(err);
		}
	}
	const [
		{ CommanderError },
		{ ensureLayout },
		{ installLayoutPreAction },
		program,
	] = await Promise.all([
		import("commander"),
		import("@dg/common/node/layout"),
		import("@dg/common/node/layout-preaction"),
		buildProgram(),
	]);

	installLayoutPreAction(program, {
		skip: SKIP,
		hooksFor: (action) => hooksFor(action.name()),
		ensure: ensureLayout,
		after: afterLayout,
	});

	try {
		await program.parseAsync([...argv], { from: "user" });
		return exitCode();
	} catch (err) {
		if (err instanceof CommanderError) return err.exitCode;
		return failure(err);
	}
}
