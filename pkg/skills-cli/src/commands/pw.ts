import type { Command } from "commander";
import { main } from "../pw/cli";
import { defaultEnv } from "../pw/core/client";
import { DAEMON_VERB } from "../pw/core/registry";
import { runDaemonFromJson } from "../pw/daemon";
import { dispatchExt, EXT_VERBS } from "../pw/ext/dispatch";
import { defaultExtTransport } from "../pw/ext/transport";
import { registerRawCommand } from "../utils/legacy-command";

/** Dispatch `pw __daemon <spec>` to the real daemon loop; every other argv goes through the client CLI. */
async function run(argv: string[]): Promise<number | void> {
	if (argv[0] === DAEMON_VERB) return runDaemonFromJson(argv[1]);
	const extIndex = argv.indexOf("--ext");
	if (extIndex === -1) return main(argv);
	const rest = [...argv.slice(0, extIndex), ...argv.slice(extIndex + 1)];
	return dispatchExt(rest, defaultEnv(), defaultExtTransport);
}

/** Register pw as its own top-level command; pw-code stays separate so a `pw` permission rule never covers it. */
export function registerPw(program: Command): void {
	registerRawCommand(program, {
		name: "pw",
		description: `Drive a browser to open, click, fill, snapshot, and record. --ext drives the real browser through the extension for: ${EXT_VERBS.join(", ")}.`,
		run,
	});
}
