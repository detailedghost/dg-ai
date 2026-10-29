import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

export function registerChannelReview(program: Command): void {
	registerLazyRaw(program, {
		name: "channel-review",
		description:
			"Run /thrash on pull requests posted in a Teams chat through a local daemon.",
		load: () => import("../channel-review/cli"),
	});
}
