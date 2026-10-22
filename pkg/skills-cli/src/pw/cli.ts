import { COMMANDS } from "./commands/index";
import { commandName, normalize, parse, UsageError } from "./core/args";
import { defaultEnv, forward, VERSION } from "./core/client";
import { commandHelp, indexHelp } from "./core/help";
import type { ClientEnv, ClientHandler } from "./core/spec";

export const RUN_CODE_MOVED = "run-code moved to pw-code (it needs your approval each time).";

/** The client side of `pw`: resolves a command and either runs it locally or forwards it to the daemon. */
export async function main(argv: readonly string[], env: ClientEnv = defaultEnv()): Promise<number> {
	try {
		const args = normalize(argv);
		const name = commandName(args);
		if (args.includes("--version")) {
			env.out(`pw ${VERSION}`);
			return 0;
		}
		if (!name) {
			env.out(indexHelp(COMMANDS.map((entry) => entry.spec)));
			return args.includes("--help") ? 0 : 2;
		}
		if (name === "run-code") {
			env.err(RUN_CODE_MOVED);
			return 2;
		}
		const entry = COMMANDS.find((candidate) => candidate.spec.name === name);
		if (!entry) {
			env.err(`Unknown command: ${name}\nRun: pw --help`);
			return 2;
		}
		if (args.includes("--help")) {
			env.out(commandHelp(entry.spec));
			return 0;
		}

		const parsed = parse(args, entry.spec);
		if (entry.spec.side === "client") {
			const handler = (await entry.load()).default as ClientHandler;
			return await handler(parsed, env);
		}

		return await forward(parsed, "run", args, env);
	} catch (error) {
		if (error instanceof UsageError) {
			env.err(error.message);
			return error.exitCode;
		}
		env.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
