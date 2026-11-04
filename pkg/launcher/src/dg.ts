import type { ProgramName } from "@dg/common/node/program";

type Program = { main(argv: string[]): Promise<number> };

const PROGRAMS: Record<ProgramName, () => Promise<Program>> = {
	"dg-skills": () => import("./programs/skills"),
	"dg-agent": () => import("./programs/agent"),
	"dg-daemon": () => import("./programs/daemon"),
};

const EX_USAGE = 64;

function isProgram(name: string | undefined): name is ProgramName {
	return name !== undefined && Object.hasOwn(PROGRAMS, name);
}

export async function dispatch(argv: readonly string[]): Promise<number> {
	const [name, ...rest] = argv;
	if (!isProgram(name)) {
		process.stderr.write(
			`dg: unknown program "${name ?? ""}"; expected ${Object.keys(PROGRAMS).join(", ")}\n`,
		);
		return EX_USAGE;
	}
	const { normalizeDgHome } = await import("@dg/common/node/dg-paths");
	normalizeDgHome();
	if (rest.length === 1 && rest[0] === "--version") {
		process.stdout.write(`${process.env.DG_BUILD_VERSION ?? "dev"}\n`);
		return 0;
	}
	const { setProgramName } = await import("@dg/common/node/program");
	setProgramName(name);
	const { main } = await PROGRAMS[name]();
	return main(rest);
}

if (import.meta.main) {
	const { exitAfterDrain } = await import("@dg/common/exit");
	await exitAfterDrain(await dispatch(process.argv.slice(2)));
}
