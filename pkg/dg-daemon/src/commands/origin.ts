import { resolveDgPaths } from "@dg/common/node";
import type { Command } from "commander";
import { clearPinnedOrigin, getPinnedOrigin } from "../server/origin";

export function registerOriginCommands(program: Command): void {
	const origin = program
		.command("origin")
		.description(
			"inspect or forget the extension origin the daemon has pinned",
		);

	origin
		.command("show")
		.description("print the pinned extension origin, or say none is pinned")
		.action(() => {
			const pinned = getPinnedOrigin(resolveDgPaths());
			console.log(pinned ?? "no origin pinned yet");
		});

	origin
		.command("clear")
		.description(
			"forget the pinned origin so the next connecting extension can pin",
		)
		.action(() => {
			clearPinnedOrigin(resolveDgPaths());
			console.log("cleared the pinned extension origin");
		});
}
