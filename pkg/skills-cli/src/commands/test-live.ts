import type { Command } from "commander";
import { registerLazyLegacy } from "../utils/lazy-command";

const description = `Temporarily deploy the current branch, wait for it to go live, then drop the temp commits.

GitHub only. Hard stops: on main/master, or no .github/workflows in the current directory.`;

export function registerTestLive(program: Command): void {
	registerLazyLegacy(program, {
		name: "test-live",
		description,
		load: async () => (await import("../test-live")).testLiveSpec,
	});
}
