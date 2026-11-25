import { buildVersion } from "@dg/common/build-version";

export type FastRoute = "hooks" | "completion" | "version";
export type RunnableFastRoute = Exclude<FastRoute, "completion">;

export function fastRoute(argv: readonly string[]): FastRoute | undefined {
	const [first, second] = argv;
	if (first === "hooks" && second === "run") return "hooks";
	if (first === "__complete") return "completion";
	if (first === "--version") return "version";
	return undefined;
}

export async function runFastRoute(route: RunnableFastRoute, argv: readonly string[]): Promise<number> {
	if (route === "hooks") return runHooks(argv.slice(1));
	process.stdout.write(`${buildVersion()}\n`);
	return 0;
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
