import type { Command } from "commander";
import { main } from "../pw/code-cli";
import { registerRawCommand } from "../utils/legacy-command";

/** A separate top-level command from pw, so a `Bash(… pw *)` permission rule never covers run-code. */
export function registerPwCode(program: Command): void {
	registerRawCommand(program, {
		name: "pw-code",
		description: "Run a Playwright code snippet against an open pw session (needs approval every call)",
		run: main,
	});
}
