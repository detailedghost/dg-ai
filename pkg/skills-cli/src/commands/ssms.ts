import { join } from "node:path";
import type { Command } from "commander";
import { MESSAGES_URL, createScriptedMessagesBrowser, runSsms } from "@dg/ssms";
import { launchCdpBrowser } from "../utils/cdp-harness";

function ssmsHome(env: NodeJS.ProcessEnv): string {
	return env.DG_HOME ?? join(env.HOME ?? "", ".dg");
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
