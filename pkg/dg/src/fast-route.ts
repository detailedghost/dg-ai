export type FastRoute = "hooks" | "completion" | "version";

export function fastRoute(argv: readonly string[]): FastRoute | undefined {
	const [first, second] = argv;
	if (first === "hooks" && second === "run") return "hooks";
	if (first === "__complete") return "completion";
	if (first === "--version") return "version";
	return undefined;
}

export async function runFastRoute(argv: readonly string[]): Promise<number> {
	switch (fastRoute(argv)) {
		case "hooks":
			return runHooks(argv.slice(1));
		case "version":
			process.stdout.write(`${process.env.DG_BUILD_VERSION ?? "dev"}\n`);
			return 0;
		default:
			throw new Error("runFastRoute handles only hooks and version");
	}
}

async function runHooks(argv: string[]): Promise<number> {
	try {
		const { main } = await import("../../skills-cli/src/hooks/cli");
		return await main(argv);
	} catch (err) {
		const [{ DgCliError, describeError }, { emitRedacted }] = await Promise.all([
			import("@dg/common/errors"),
			import("@dg/common/redact"),
		]);
		emitRedacted((line) => console.error(line), `dg: ${describeError(err)}`);
		return err instanceof DgCliError ? err.exitCode : 1;
	}
}
