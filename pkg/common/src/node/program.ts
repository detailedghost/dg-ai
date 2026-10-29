import { isAbsolute, join } from "node:path";

export type ProgramName = "dg-skills" | "dg-agent" | "dg-daemon";

let recorded: ProgramName | undefined;

export function setProgramName(name: ProgramName | undefined): void {
	recorded = name;
}

export function programName(): ProgramName | undefined {
	return recorded;
}

/** argv for a program on this runtime and bundle: [bun, dg.js, name, ...args]. */
export function programCommand(name: ProgramName, args: readonly string[]): string[] {
	return recorded
		? [process.execPath, Bun.main, name, ...args]
		: [process.execPath, Bun.main, ...args];
}

/** argv for service units: the stable current links, never a version directory. */
export function launcherCommand(root: string, name: ProgramName, args: readonly string[]): string[] {
	if (!isAbsolute(root)) throw new Error(`launcher root must be absolute: ${root}`);
	const bun = process.platform === "win32" ? "bun.exe" : "bun";
	return [join(root, "runtime", "current", bun), join(root, "lib", "current", "dg.js"), name, ...args];
}
