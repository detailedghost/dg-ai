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
	] = await Promise.all([
		import("commander"),
		import("@dg/common"),
		import("./commands/jobs"),
		import("./commands/origin"),
		import("./commands/sessions"),
		import("./commands/service"),
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
		.command("__serve", { hidden: true })
		.description(
			"internal: run the daemon in the foreground (never call directly)",
		)
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

	try {
		await program.parseAsync([...argv], { from: "user" });
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	} catch (err) {
		if (err instanceof CommanderError) return err.exitCode;
		emitRedacted((line) => console.error(line), `dg-daemon: ${describeError(err)}`);
		return err instanceof DgCliError ? err.exitCode : EXIT_GENERAL_FAILURE;
	}
}
