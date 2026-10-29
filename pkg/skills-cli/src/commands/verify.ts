import type { Command } from "commander";
import { main } from "../verify";
import { registerRawCommand } from "../utils/legacy-command";

/** Register verify with the raw parser so paths, engines, and statuses pass through unchanged. */
export function registerVerify(program: Command): void {
	registerRawCommand(program, {
		name: "verify",
		description:
			"Review finished changes round by round on a local before-and-after board",
		run: main,
	});
}
