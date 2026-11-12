import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { MESSAGES_URL, askSendApproval, createScriptedMessagesBrowser, runSsms } from "@dg/ssms";
import { launchCdpBrowser } from "../utils/cdp-harness";

function ssmsHome(env: NodeJS.ProcessEnv): string {
	return resolveDgPaths({ env, homeDir: env.HOME || homedir() }).stateDir;
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

export async function runSsmsCommand(args: string[]): Promise<number> {
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
	return result.code;
}
