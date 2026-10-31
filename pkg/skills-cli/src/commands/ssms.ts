import { join } from "node:path";
import type { Command } from "commander";
import { MESSAGES_URL, askSendApproval, createScriptedMessagesBrowser, runSsms } from "@dg/ssms";
import { launchCdpBrowser } from "../utils/cdp-harness";

function ssmsHome(env: NodeJS.ProcessEnv): string {
	return env.DG_HOME ?? join(env.HOME ?? "", ".dg");
}

export function ssmsCommandRuntime(stdin: {
	isTTY?: boolean;
	resume?: () => void;
	pause?: () => void;
	once: (event: "data", listener: (chunk: Uint8Array) => void) => void;
} = process.stdin): { stdinIsTTY: boolean; ask?: (draftId: string) => Promise<boolean> } {
	const stdinIsTTY = stdin.isTTY === true;
	return {
		stdinIsTTY,
		ask: stdinIsTTY
			? (draftId) => askSendApproval(draftId, stdin, (line) => process.stderr.write(line))
			: undefined,
	};
}

export function registerSsms(program: Command): void {
	program
		.command("ssms")
		.description(
			"Read and clean SMS. google drives Messages for Web; signal wraps signal-cli.",
		)
		.helpOption(false)
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.argument("[args...]", "provider, verb, and options")
		.action(async (args: string[] = []) => {
			const needsBrowser =
				args[0] === "google" && !args.includes("--help") && !args.includes("-h");
			const home = ssmsHome(process.env);
			const result = await runSsms(args, {
				stdio: "inherit",
				env: process.env,
				home,
				...ssmsCommandRuntime(),
				openBrowser: needsBrowser
					? async () => {
							const page = await launchCdpBrowser({
								profileDir: join(home, "ssms", "google-profile"),
								url: MESSAGES_URL,
								headless: process.env.DG_SSMS_HEADLESS === "1",
							});
							return createScriptedMessagesBrowser(page);
						}
					: undefined,
			});
			process.exitCode = result.code;
		});
}
