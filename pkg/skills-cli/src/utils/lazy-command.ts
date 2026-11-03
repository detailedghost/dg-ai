import { Command } from "commander";
import { type CommandSpec, registerRawCommand, runCommandSpec } from "./legacy-command";

export interface LazyRaw {
	name: string;
	description: string;
	load(): Promise<{ main(argv: string[]): Promise<number | void> | number | void }>;
}

export interface LazyLegacy {
	name: string;
	description: string;
	load(): Promise<CommandSpec>;
}

/** Registers the name and help now; the feature module loads on first use. */
export function registerLazyRaw(program: Command, spec: LazyRaw): void {
	registerRawCommand(program, {
		name: spec.name,
		description: spec.description,
		run: async (argv) => (await spec.load()).main(argv),
	});
}

export function registerLazyLegacy(program: Command, spec: LazyLegacy): void {
	registerRawCommand(program, {
		name: spec.name,
		description: spec.description,
		run: async (argv) => runCommandSpec(await spec.load(), argv),
	});
}

/** Runs a feature-owned Commander subtree as `dg-skills <name> ...argv`; its errors reach the main handler. */
export async function runSubtree(
	name: string,
	register: (program: Command) => void,
	argv: string[],
): Promise<void> {
	const root = new Command("dg-skills").showHelpAfterError().exitOverride();
	root.enablePositionalOptions();
	register(root);
	await root.parseAsync([name, ...argv], { from: "user" });
}
