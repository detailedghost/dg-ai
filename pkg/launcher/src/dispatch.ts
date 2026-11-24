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

const NO_JIT: readonly (readonly string[])[] = [
	["agent", "phone", "listen"],
	["phone", "listen"],
	["daemon", "serve"],
	["prototype", "serve"],
];

const MOUNT_WORD: Partial<Record<ProgramName, string>> = { "dg-agent": "agent", "dg-daemon": "daemon" };

/** Re-executes a long-running command with the JSC JIT off; the pid stays the same. */
async function reexecWithoutJit(name: ProgramName, args: readonly string[], argv: readonly string[]): Promise<void> {
	if (process.env.BUN_JSC_useJIT !== undefined || process.platform === "win32" || typeof process.execve !== "function") return;
	const mount = MOUNT_WORD[name];
	const words = mount ? [mount, ...args] : args;
	if (!NO_JIT.some((form) => form.every((word, index) => words[index] === word))) return;
	const { isCompiled } = await import("@dg/common/node/program");
	process.execve(process.execPath, [process.argv0, ...(isCompiled() ? [] : [Bun.main]), ...argv], { ...process.env, BUN_JSC_useJIT: "0" });
}

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
	await reexecWithoutJit(name, args, argv);
	if (isOldName(name)) process.stderr.write(removed(name, args));
	const { normalizeDgHome } = await import("@dg/common/node/dg-paths");
	normalizeDgHome();
	if (args.length === 1 && args[0] === "--version") {
		process.stdout.write(`${process.env.DG_BUILD_VERSION ?? "dev"}\n`);
		return 0;
	}
	const { setProgramName } = await import("@dg/common/node/program");
	setProgramName(name);
	if (bridge) {
		const { finishLegacyUpgrade } = await import("@dg/skills-cli/finish-upgrade");
		await finishLegacyUpgrade(name, args);
	}
	const { main } = await PROGRAMS[name]();
	return main(args);
}

