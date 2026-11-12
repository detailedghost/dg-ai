import type { Command } from "commander";
import { registerLazyLegacy } from "../utils/lazy-command";

/** Register bg with the compatibility dispatcher; help, usage exit 2 and handler exit 1 stay legacy. */
export function registerBg(program: Command): void {
	registerLazyLegacy(program, {
		name: "bg",
		description: "Detached background-job primitive for the /bg skill.",
		load: async () => (await import("../bg")).bgSpec,
	});
}
