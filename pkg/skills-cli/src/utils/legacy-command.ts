import { Command as CommanderCommand } from "commander";

/** Compatibility status vocabulary; raw commands retain their own observed exit codes. */
export const EXIT = { OK: 0, ERR: 1, USAGE: 2, VALIDATION: 3, UNSUPPORTED: 4 } as const;

/** Write a prefixed error to stderr and terminate with the requested status. */
export function die(msg: string, code = 1): never {
	process.stderr.write(`error: ${msg}\n`);
	process.exit(code);
}

/** Describe a legacy handler receiving raw arguments after global help/json flags are removed. */
export interface SubcommandSpec {
	description?: string;
	args?: string[];
	run: (args: string[], opts: { json: boolean; help: boolean }) => Promise<number | void>;
}

/** Declare the subcommand map used by the compatibility dispatcher and its generated help. */
export interface CommandSpec {
	name: string;
	description?: string;
	subcommands: Record<string, SubcommandSpec>;
}

/** An explicit argv runner; invoking run terminates the process with the handler status. */
export interface Command {
	/** Dispatch argv and terminate the process with the selected handler's status. */
	run(argv: string[]): Promise<void>;
}

function buildUsage(spec: CommandSpec): string {
	const lines: string[] = [];
	if (spec.description) lines.push(spec.description, "");
	lines.push(`Usage: ${spec.name} <subcommand> [options]`, "", "Subcommands:");
	for (const [name, sub] of Object.entries(spec.subcommands)) {
		const argList = sub.args?.length ? ` ${sub.args.map((a) => `<${a}>`).join(" ")}` : "";
		const desc = sub.description ? `  — ${sub.description}` : "";
		lines.push(`  ${name}${argList}${desc}`);
	}
	lines.push("", "Options:", "  --help, -h   Show this help", "  --json       Emit JSON output");
	return lines.join("\n");
}

/** Build an inert dispatcher; run handles help/usage and converts handler exceptions to exit 1. */
export function defineCommand(spec: CommandSpec): Command {
	return {
		async run(argv: string[]) {
			const json = argv.includes("--json");
			const help = argv.includes("--help") || argv.includes("-h");
			const filtered = argv.filter((a) => a !== "--json" && a !== "--help" && a !== "-h");

			const subName = filtered.find((a) => !a.startsWith("-"));

			if (help) {
				process.stdout.write(buildUsage(spec) + "\n");
				process.exit(EXIT.OK);
			}
			if (!subName) {
				process.stdout.write(buildUsage(spec) + "\n");
				process.exit(EXIT.USAGE);
			}

			const sub = spec.subcommands[subName];
			if (!sub) {
				process.stderr.write(`${spec.name}: unknown subcommand '${subName}'\n\n${buildUsage(spec)}\n`);
				process.exit(EXIT.USAGE);
			}

			const subAt = filtered.indexOf(subName);
			const subArgs = filtered.filter((_, i) => i !== subAt);

			try {
				const code = (await sub.run(subArgs, { json, help })) ?? EXIT.OK;
				process.exit(code);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`${spec.name} ${subName}: ${msg}\n`);
				process.exit(EXIT.ERR);
			}
		},
	};
}

/** Describe a custom parser that owns every argument and may return its own exit status. */
export interface RawCommandSpec {
	name: string;
	description?: string;
	run: (argv: string[]) => number | void | Promise<number | void>;
}

/** Register without consuming help, unknown options, or literal --; forward returned statuses unchanged. */
export function registerRawCommand(program: CommanderCommand, spec: RawCommandSpec): void {
	const command = new CommanderCommand(spec.name)
		.description(spec.description ?? "")
		.helpOption(false)
		.allowUnknownOption()
		.allowExcessArguments()
		.passThroughOptions()
		.exitOverride();
	// Commander normally consumes a leading --; legacy parsers own every argument.
	command.parseOptions = (argv) => ({ operands: [...argv], unknown: [] });
	command.action(async () => {
		const code = await spec.run(command.args);
		if (code !== undefined) process.exit(code);
	});
	program.addCommand(command);
}

/** Attach the compatibility dispatcher to Commander without executing it during registration. */
export function registerLegacyCommand(program: CommanderCommand, spec: CommandSpec): void {
	const command = defineCommand(spec);
	registerRawCommand(program, {
		name: spec.name,
		description: spec.description,
		run: (argv) => command.run(argv),
	});
}
