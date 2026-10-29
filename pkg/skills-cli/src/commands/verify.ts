import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register verify with the raw parser so paths, engines, and statuses pass through unchanged. */
export function registerVerify(program: Command): void {
	registerLazyRaw(program, {
		name: "verify",
		description: "Review finished changes round by round on a local before-and-after board",
		load: () => import("../verify"),
	});
}
