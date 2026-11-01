import { CODE_COMMAND } from "./code/index";
import {
	normalize,
	optionArgs,
	parse,
	stringFlag,
	UsageError,
} from "./core/args";
import { bunVersionError } from "./core/bun-version";
import { defaultEnv, forward, VERSION } from "./core/client";
import { GLOBAL_HELP } from "./core/help";
import type { ClientEnv } from "./core/spec";

export const CODE_HELP = [
	"Usage: pw-code [-s=<name>] [--raw] <code>",
	"       pw-code [-s=<name>] [--raw] --filename=<file>",
	"",
	CODE_COMMAND.spec.help,
	"",
	"pw-code runs arbitrary code inside the browser session, so the agent asks you before every run.",
	"",
	"Options:",
	"  --filename=<value>      load the code from this file (relative paths resolve against the current directory)",
	"",
	"Global options:",
	...GLOBAL_HELP,
].join("\n");

export async function main(
	argv: readonly string[],
	env: ClientEnv = defaultEnv(),
): Promise<number> {
	const versionError = bunVersionError(Bun.version);
	if (versionError) {
		env.err(versionError);
		return 1;
	}
	try {
		const args = normalize(argv);
		const options = optionArgs(args);
		if (options.includes("--version")) {
			env.out(`pw-code ${VERSION}`);
			return 0;
		}
		if (options.includes("--help")) {
			env.out(CODE_HELP);
			return 0;
		}
		const forwarded = [CODE_COMMAND.spec.name, ...args];
		const parsed = parse(forwarded, CODE_COMMAND.spec);
		if (
			parsed.positionals.length === 0 &&
			stringFlag(parsed, "filename") === undefined
		) {
			throw new UsageError(
				`Provide the code as an argument or with --filename\n\n${CODE_HELP}`,
			);
		}
		return await forward(parsed, "code", forwarded, env);
	} catch (error) {
		if (error instanceof UsageError) {
			env.err(error.message);
			return error.exitCode;
		}
		env.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
