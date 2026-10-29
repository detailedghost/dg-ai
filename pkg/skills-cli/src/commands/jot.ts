import type { Command } from "commander";
import { registerLazyLegacy } from "../utils/lazy-command";

/** Register jot with the compatibility dispatcher; help, usage exit 2 and handler exit 1 stay legacy. */
export function registerJot(program: Command): void {
	registerLazyLegacy(program, {
		name: "jot",
		description: "Agent notes (scratch) and session saves (durable), capped at 2 KB per file.",
		load: async () => (await import("../jot")).jotSpec,
	});
}
