import type { LayoutHooks } from "@dg/common/node/layout";
import type { Command } from "commander";

const SKIP = new Set(["status"]);

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
	if (action.name() !== "serve") return;
	const [{ daemonLayoutHooks }, { resolveDgPaths }, { assertNotBlocked }] = await Promise.all([
		import("./layout-hooks"),
		import("@dg/common/node/dg-paths"),
		import("@dg/common/node/layout"),
	]);
	const paths = resolveDgPaths();
	assertNotBlocked(paths, "daemon");
	await daemonLayoutHooks().keychainMove(paths);
}

export async function main(argv: readonly string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		process.stdout.write(`${process.env.DG_BUILD_VERSION ?? "dev"}\n`);
		return 0;
	}
	const [
		{ Command, CommanderError },
		{ DgCliError, describeError, emitRedacted, EXIT_GENERAL_FAILURE, forever },
		{ registerJobCommands },
		{ registerOriginCommands },
		{ registerSessionCommands },
		{ registerServiceCommands },
		{ ensureLayout },
		{ installLayoutPreAction },
	] = await Promise.all([
		import("commander"),
		import("@dg/common"),
		import("./commands/jobs"),
		import("./commands/origin"),
		import("./commands/sessions"),
		import("./commands/service"),
		import("@dg/common/node/layout"),
		import("@dg/common/node/layout-preaction"),
	]);
	const program = new Command();
	program
		.name("dg-daemon")
		.description(
			"Loopback HTTP+WebSocket daemon hosting many chat sessions for dg:start.",
		)
		.showHelpAfterError()
		.exitOverride();

	program
		.command("serve")
		.description("Run the daemon in the foreground; dg starts this for you")
		.action(async () => {
			const { cmdServe } = await import("./server/bootstrap");
			if ((await cmdServe()) === "serving") await forever();
		});

	program
		.command("status")
		.description("report the live daemon's status, or that none is running")
		.action(async () => {
			const { cmdStatus } = await import("./server/bootstrap");
			await cmdStatus();
		});

	registerJobCommands(program);
	registerOriginCommands(program);
	registerSessionCommands(program);
	registerServiceCommands(program);

	installLayoutPreAction(program, {
		skip: SKIP,
		hooksFor: (action) => hooksFor(action.name()),
		ensure: ensureLayout,
		after: afterLayout,
	});

	try {
		await program.parseAsync([...argv], { from: "user" });
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	} catch (err) {
		if (err instanceof CommanderError) return err.exitCode;
		emitRedacted((line) => console.error(line), `dg-daemon: ${describeError(err)}`);
		return err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE;
	}
}
