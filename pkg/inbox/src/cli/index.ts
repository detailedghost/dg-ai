#!/usr/bin/env bun
import type { InboxRuntime } from "../runtime";
import { resolve } from "node:path";
import { parseArgs } from "./args";
import { commandRegistry } from "./commands";
import { createCliContext } from "./context";
import { dispatch, printHelp } from "./router";

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

if (
	import.meta.main ||
	Bun.main === import.meta.path ||
	resolve(Bun.argv[1] ?? "") === import.meta.path
) {
	try {
		await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
