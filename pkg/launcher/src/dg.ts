import type { ProgramName } from "@dg/common/node/program";

type Program = { main(argv: string[]): Promise<number> };

const PROGRAMS: Record<ProgramName, () => Promise<Program>> = {
	"dg-skills": () => import("./programs/skills"),
	"dg-agent": () => import("./programs/agent"),
	"dg-daemon": () => import("./programs/daemon"),
	dg: () => import("./programs/dg"),
};

const NEW_FORM: Record<Exclude<ProgramName, "dg">, string> = { "dg-skills": "dg", "dg-agent": "dg agent", "dg-daemon": "dg daemon" };

function isOldName(name: string | undefined): name is Exclude<ProgramName, "dg"> {
	return name !== undefined && Object.hasOwn(NEW_FORM, name);
}

const removed = (name: Exclude<ProgramName, "dg">, args: readonly string[]): string =>
	`dg: the ${name} command is removed; run ${[NEW_FORM[name], ...args].join(" ")}\n`;

function invokedName(argv0: string | undefined): string | undefined {
	return argv0
		?.split(/[\\/]/)
		.at(-1)
		?.replace(/\.exe$/i, "");
}

/** Runs dg with `argv`; an old program name as first word is the 6.3 bridge, as invoked name it exits 1. */
export async function dispatch(argv: readonly string[], argv0?: string): Promise<number> {
	const invoked = invokedName(argv0);
	if (isOldName(invoked)) {
		process.stderr.write(removed(invoked, argv));
		return 1;
	}
	const [first, ...rest] = argv;
	const bridge = isOldName(first) || first === "dg";
	const name: ProgramName = bridge ? (first as ProgramName) : "dg";
	const args = bridge ? rest : [...argv];
	if (isOldName(name)) process.stderr.write(removed(name, args));
	const { normalizeDgHome } = await import("@dg/common/node/dg-paths");
	normalizeDgHome();
	if (args.length === 1 && args[0] === "--version") {
		process.stdout.write(`${process.env.DG_BUILD_VERSION ?? "dev"}\n`);
		return 0;
	}
	const { setProgramName } = await import("@dg/common/node/program");
	setProgramName(name);
	const { main } = await PROGRAMS[name]();
	return main(args);
}

if (import.meta.main) {
	const { exitAfterDrain } = await import("@dg/common/exit");
	await exitAfterDrain(await dispatch(process.argv.slice(2), process.argv0));
}
