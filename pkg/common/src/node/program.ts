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

/** argv for a program on this runtime and bundle: [bun, dg.js, name, ...args], or its source entry in a checkout. */
export function programCommand(name: ProgramName, args: readonly string[]): string[] {
	if (recorded) return [process.execPath, Bun.main, name, ...args];
	const entry = join(import.meta.dir, "..", "..", "..", SOURCE_PACKAGES[name], "src", "index.ts");
	return [process.execPath, entry, ...args];
}

/** argv for service units: the stable current links, never a version directory. */
export function launcherCommand(root: string, name: ProgramName, args: readonly string[]): string[] {
	if (!isAbsolute(root)) throw new Error(`launcher root must be absolute: ${root}`);
	const bun = process.platform === "win32" ? "bun.exe" : "bun";
	return [join(root, "runtime", "current", bun), join(root, "lib", "current", "dg.js"), name, ...args];
}
