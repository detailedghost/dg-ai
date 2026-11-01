import { COMMANDS, type CommandEntry } from "./commands/index";
import { commandName, normalize, parse, UsageError } from "./core/args";
import { BrowserMissingError } from "./core/browser";
import { bunVersionError } from "./core/bun-version";
import { defaultEnv, forward, VERSION } from "./core/client";
import { commandHelp, indexHelp } from "./core/help";
import type { ClientEnv, ClientHandler } from "./core/spec";

export const RUN_CODE_MOVED =
	"run-code moved to pw-code (it needs your approval each time).";

export async function main(
	argv: readonly string[],
	env: ClientEnv = defaultEnv(),
	commands: readonly CommandEntry[] = COMMANDS,
): Promise<number> {
	if (argv[0] === "__daemon") {
		await (await import("./daemon")).runDaemon(argv[1]);
		return new Promise<number>(() => undefined);
	}
	const versionError = bunVersionError(Bun.version);
	if (versionError) {
		env.err(versionError);
		return 1;
	}
	try {
		const args = normalize(argv);
		const name = commandName(args);
		if (args.includes("--version")) {
			env.out(`pw ${VERSION}`);
			return 0;
		}
		if (!name) {
			env.out(indexHelp(commands.map((entry) => entry.spec)));
			return args.includes("--help") ? 0 : 2;
		}
		if (name === "run-code") {
			env.err(RUN_CODE_MOVED);
			return 2;
		}
		const entry = commands.find((candidate) => candidate.spec.name === name);
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
		if (error instanceof UsageError || error instanceof BrowserMissingError) {
			env.err(error.message);
			return error.exitCode;
		}
		env.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
