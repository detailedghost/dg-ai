import type { Command } from "commander";
import { registerLazyLegacy } from "../utils/lazy-command";

/** Register the provider compatibility dispatcher without detecting a provider during import or registration. */
export function registerVcsProvider(program: Command): void {
	registerLazyLegacy(program, {
		name: "vcs-provider",
		description:
			"Query the detected VCS provider (GitHub or GitLab) for repo info, issues, and pull requests. Run dg-skills vcs-provider <subcommand>.",
		load: async () => (await import("../vcs-provider")).commandSpec,
	});
}
