import { isAbsolute, join } from "node:path";

export const PROGRAM_NAMES = ["dg-skills", "dg-agent", "dg-daemon"] as const;
export type ProgramName = (typeof PROGRAM_NAMES)[number] | "dg";

let recorded: ProgramName | undefined;
let mounted: Exclude<ProgramName, "dg"> | undefined;

export function setProgramName(name: ProgramName | undefined): void {
	recorded = name;
	mounted = undefined;
}

/** Names the program that `dg` mounted, so `selfCommand` builds its argv and not that of `dg`. */
export function mountProgram(name: Exclude<ProgramName, "dg">): void {
	if (recorded) recorded = name;
	else mounted = name;
}

export function mountedProgram(): Exclude<ProgramName, "dg"> | undefined {
	return mounted;
}

export function programName(): ProgramName | undefined {
	return recorded;
}

const SOURCE_PACKAGES: Record<ProgramName, string> = {
	"dg-skills": "skills-cli",
	"dg-agent": "dg-agent",
	"dg-daemon": "dg-daemon",
	dg: "dg",
};

/** The dg words that run one program: `skills`, `agent`, `daemon`, or none for dg itself. */
export const GROUP_WORDS: Record<ProgramName, readonly string[]> = {
	"dg-skills": ["skills"],
	"dg-agent": ["agent"],
	"dg-daemon": ["daemon"],
	dg: [],
};

/** True inside a `bun build --compile` executable. */
export const isCompiled = (main: string = Bun.main): boolean => main.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main);

/** argv for a program of this dg: the compiled program, the bundle, or its source entry in a checkout. */
export function programCommand(name: ProgramName, args: readonly string[]): string[] {
	if (recorded) {
		const head = isCompiled() ? [process.execPath] : [process.execPath, Bun.main];
		return [...head, ...GROUP_WORDS[name], ...args];
	}
	const entry = join(import.meta.dir, "..", "..", "..", SOURCE_PACKAGES[name], "src", "index.ts");
	return [process.execPath, entry, ...args];
}

const exeName = (platform: NodeJS.Platform): string => (platform === "win32" ? "dg.exe" : "dg");

/** The stable path of the compiled program: `<root>/bin/current/dg[.exe]`. */
export function compiledProgramPath(root: string, platform: NodeJS.Platform = process.platform): string {
	if (!isAbsolute(root)) throw new Error(`launcher root must be absolute: ${root}`);
	return join(root, "bin", "current", exeName(platform));
}

/** argv for service units: the stable current link, never a version directory. */
export function launcherCommand(root: string, name: ProgramName, args: readonly string[]): string[] {
	return [compiledProgramPath(root), ...GROUP_WORDS[name], ...args];
}

const OLD_NAME = /^(.*?)(dg-skills|dg-agent|dg-daemon)(\.cmd|\.exe)?$/i;
const BUNDLE = /^(.*)[\\/]runtime[\\/]current[\\/]bun(\.exe)?$/i;

function words(program: string | undefined): readonly string[] | undefined {
	return program !== undefined && Object.hasOwn(GROUP_WORDS, program) ? GROUP_WORDS[program as ProgramName] : undefined;
}

/**
 * Maps argv that runs the 6.3 bundle (`<root>/runtime/current/bun <root>/lib/current/dg.js <program> ...`)
 * or an old program name (`dg-skills ...`, `<bin>/dg-skills.cmd ...`) to the compiled dg form.
 * With `root`, an old program name maps to the absolute compiled program of that root.
 * Returns undefined for any other argv.
 */
export function rewriteLauncherArgv(argv: readonly string[], root?: string): string[] | undefined {
	const [head = "", second, third, ...rest] = argv;
	const bundle = BUNDLE.exec(head);
	if (bundle) {
		const [, root = "", exe] = bundle;
		const sep = head.includes("\\") ? "\\" : "/";
		const group = words(third);
		if (second !== [root, "lib", "current", "dg.js"].join(sep) || !group) return undefined;
		return [[root, "bin", "current", exe ? "dg.exe" : "dg"].join(sep), ...group, ...rest];
	}
	const old = OLD_NAME.exec(head);
	if (!old) return undefined;
	const [, dir = "", name = "", ext] = old;
	if (dir !== "" && !/[\\/]$/.test(dir)) return undefined;
	const local = dir === "" ? "dg" : ext ? `${dir}dg.exe` : `${dir}dg`;
	const exe = root === undefined ? local : compiledProgramPath(root);
	return [exe, ...(words(name.toLowerCase()) ?? []), ...argv.slice(1)];
}
