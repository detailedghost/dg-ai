import type { Command } from "commander";
import { resolveDgPaths, type DgPaths } from "./dg-paths";
import type { LayoutHooks, LayoutResult } from "./layout";

export type LayoutPreActionOptions = {
	skip: ReadonlySet<string>;
	hooksFor: (action: Command) => LayoutHooks;
	ensure: (paths: DgPaths, hooks: LayoutHooks) => Promise<LayoutResult>;
	after?: (action: Command, result: LayoutResult) => Promise<void>;
};

const pathBelowProgram = (command: Command): string[] =>
	command.parent ? [...pathBelowProgram(command.parent), command.name()] : [];

const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

const asksForHelp = (args: readonly string[]): boolean => {
	const end = args.indexOf("--");
	return (end === -1 ? args : args.slice(0, end)).some((arg) => HELP_FLAGS.has(arg));
};

const handlesOwnHelp = (action: Command): boolean =>
	action.createHelp().visibleOptions(action).some((option) => HELP_FLAGS.has(option.long ?? ""));

/** True for a help flag before any `--` forwarded by a command without its own help, or when the command path (alone or plus its first raw argument) is in the skip set. */
export function shouldSkip(action: Command, skip: ReadonlySet<string>): boolean {
	if (!handlesOwnHelp(action) && asksForHelp(action.args)) return true;
	const path = pathBelowProgram(action).join(" ");
	return skip.has(path) || skip.has(`${path} ${action.args[0] ?? ""}`);
}

/** Runs `ensure` then `after` before every command body except the skipped ones. */
export function installLayoutPreAction(program: Command, { skip, hooksFor, ensure, after }: LayoutPreActionOptions): void {
	program.hook("preAction", async (_thisCommand, action) => {
		if (shouldSkip(action, skip)) return;
		const result = await ensure(resolveDgPaths(), hooksFor(action));
		await after?.(action, result);
	});
}
