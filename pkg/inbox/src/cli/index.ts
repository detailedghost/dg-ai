#!/usr/bin/env bun
import type { InboxRuntime } from "../runtime";
import { parseArgs } from "./args";
import { commandRegistry } from "./commands";
import { createCliContext } from "./context";
import { dispatch, printHelp } from "./router";

/** Runs inbox arguments with optional service hooks; help and explicit fixture datasets stay offline. */
export async function main(
	argv = Bun.argv.slice(2),
	runtime: InboxRuntime = {},
): Promise<void> {
	const args = parseArgs(argv);
	if (args.group === "help" || args.flags.help === true) {
		printHelp();
		return;
	}
	const context = await createCliContext(args, runtime);
	await dispatch(context, commandRegistry);
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
