import { Command as CommanderCommand } from "commander";

export const EXIT = { OK: 0, ERR: 1, USAGE: 2, VALIDATION: 3, UNSUPPORTED: 4 } as const;

export function die(msg: string, code = 1): never {
	process.stderr.write(`error: ${msg}\n`);
	process.exit(code);
}

export interface SubcommandSpec {
	description?: string;
	args?: string[];
	run: (args: string[], opts: { json: boolean; help: boolean }) => Promise<number | void>;
}

export interface CommandSpec {
	name: string;
	description?: string;
	subcommands: Record<string, SubcommandSpec>;
}

export interface Command {
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

export interface RawCommandSpec {
	name: string;
	description?: string;
	run: (argv: string[]) => number | void | Promise<number | void>;
}

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

export function registerLegacyCommand(program: CommanderCommand, spec: CommandSpec): void {
	const command = defineCommand(spec);
	registerRawCommand(program, {
		name: spec.name,
		description: spec.description,
		run: (argv) => command.run(argv),
	});
}
