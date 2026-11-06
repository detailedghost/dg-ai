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

/** True for a forwarded help flag, or when the command path (alone or plus its first raw argument) is in the skip set. */
export function shouldSkip(action: Command, skip: ReadonlySet<string>): boolean {
	if (HELP_FLAGS.has(action.args[0] ?? "")) return true;
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
