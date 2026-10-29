import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register spec with its raw parser so every verb keeps its observed exit status. */
export function registerSpec(program: Command): void {
	registerLazyRaw(program, {
		name: "spec",
		description: "Scaffold, validate, review and edit spec plan bundles for /spec orchestration",
		load: () => import("../spec"),
	});
}
