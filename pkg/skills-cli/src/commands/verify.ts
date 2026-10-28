import type { Command } from "commander";
import { main } from "../verify";
import { registerRawCommand } from "../utils/legacy-command";

/** Register verify with the raw parser so paths, engines, and statuses pass through unchanged. */
export function registerVerify(program: Command): void {
	registerRawCommand(program, {
		name: "verify",
		description:
			"Review finished changes side by side and record Approve, Reject, or Tweak",
		run: main,
	});
}
