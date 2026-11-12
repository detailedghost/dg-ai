export const VERSION = process.env.DG_BUILD_VERSION ?? "dev";

export async function main(argv: readonly string[]): Promise<number> {
	if (argv.length === 1 && argv[0] === "--version") {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}
	const [{ Command, CommanderError }, { registerAll }] = await Promise.all([
		import("commander"),
		import("./register-all"),
	]);
	const program = new Command()
		.name("dg-skills")
		.description(
			"Review inboxes, run channel reviews, group marked tabs, play guided tours, compare live-page prototypes, and review finished changes.",
		)
		.showHelpAfterError()
		.version(VERSION)
		.exitOverride();
	program.enablePositionalOptions();
	registerAll(program);
	try {
		await program.parseAsync([...argv], { from: "user" });
		return typeof process.exitCode === "number" ? process.exitCode : 0;
	} catch (err) {
		if (err instanceof CommanderError) return err.exitCode;
		const { DgCliError, describeError, emitRedacted } = await import(
			"@dg/common"
		);
		emitRedacted(
			(line) => console.error(line),
			`dg-skills: ${describeError(err)}`,
		);
		return err instanceof DgCliError ? err.exitCode : 1;
	}
}
