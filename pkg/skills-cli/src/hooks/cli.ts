import { defaultSeams, runHook } from "./run";
import type { HookEnv, HookSeams } from "./types";

export interface HooksIo {
	stdin: AsyncIterable<string | Uint8Array>;
	env: HookEnv;
	seams: HookSeams;
}

const USAGE = "usage: hooks run <id>\n";

export async function main(
	argv: string[],
	io: HooksIo = {
		stdin: process.stdin,
		env: process.env,
		seams: defaultSeams(),
	},
): Promise<number> {
	const [command, id, ...flags] = argv;
	if (command !== "run" || !id) {
		io.seams.stderr(USAGE);
		return 2;
	}
	if (
		id === "daily-prune" &&
		flags.includes("--dry-run") &&
		!flags.includes("--now")
	) {
		io.seams.stderr("hooks run daily-prune: --dry-run requires --now\n");
		return 2;
	}
	if (id === "daily-prune" && flags.includes("--now")) {
		const { runNow } = await import("./defs/daily-prune");
		await runNow(io.env, io.seams.run, flags.includes("--dry-run"));
		return 0;
	}
	return runHook(id, io.stdin, io.env, io.seams);
}
