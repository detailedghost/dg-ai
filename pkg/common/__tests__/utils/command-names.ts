import { afterEach, beforeEach } from "bun:test";
import { Command } from "commander";

type Walked = Command & { commands: Command[] };
type ProgramMain = { main: (argv: readonly string[]) => Promise<number> };

/** Captures the program that `main` builds, so a spec can walk its commands without parsing argv. */
export function captureProgram(): (load: () => Promise<ProgramMain>) => Promise<string[]> {
	const parseAsync = Command.prototype.parseAsync;
	let captured: Command | undefined;
	beforeEach(() => {
		captured = undefined;
		Command.prototype.parseAsync = async function (this: Command) {
			captured = this;
			return this;
		};
	});
	afterEach(() => {
		Command.prototype.parseAsync = parseAsync;
	});
	return async (load) => {
		await (await load()).main([]);
		if (!captured) throw new Error("program was not built");
		return commandPaths(captured);
	};
}

function commandPaths(command: Command, prefix = ""): string[] {
	return (command as Walked).commands.flatMap((child) => {
		const path = `${prefix}${child.name()}`;
		return [path, ...commandPaths(child, `${path} `)];
	});
}

/** Command paths with a segment that starts with a double underscore. */
export const underscored = (paths: readonly string[]): string[] =>
	paths.filter((path) => path.split(" ").some((part) => part.startsWith("__")));
