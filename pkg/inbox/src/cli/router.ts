import { Command } from "commander";
import type { CliContext } from "./context";
import {
	cliCommandSpecs,
	cliOptions,
	commandHelpText,
	createHelpProgram,
	helpFlagsFor,
	matchCliCommand,
} from "./args";

export type CommandHandler = (context: CliContext) => Promise<void>;

export type CommandRegistry = Record<string, CommandHandler>;

export function commandKey(group: string, action: string): string {
	return action ? `${group}:${action}` : group;
}

export async function dispatch(
	context: CliContext,
	registry: CommandRegistry,
): Promise<void> {
	const key = commandKey(context.args.group, context.args.action);
	const handler = registry[key];
	if (!handler) {
		throw new Error(
			`Unknown command: ${context.args.group} ${context.args.action}`.trim(),
		);
	}
	await handler(context);
}

export function printHelp(): void {
	console.log(
		`${createHelpProgram().helpInformation().trimEnd()}\n\n${commandHelpText()}`,
	);
}

/** Usage and flags for one command. Unknown names list the matching commands only. */
export function printCommandHelp(group: string, action: string): void {
	const spec = matchCliCommand(group, action);
	if (!spec) {
		const related = cliCommandSpecs.filter(
			(item) => item.nameAndArgs.split(" ")[0] === group,
		);
		const lines = related.length > 0 ? related : cliCommandSpecs;
		console.log(
			[
				`Unknown command: ${[group, action].filter(Boolean).join(" ")}`,
				"",
				"Commands:",
				...lines.map(
					(item) => `  ${item.nameAndArgs.padEnd(28)} ${item.description}`,
				),
			].join("\n"),
		);
		return;
	}
	const usage =
		spec.nameAndArgs.includes("<") && action
			? `${spec.nameAndArgs.split(" ")[0]} ${action}`
			: spec.nameAndArgs;
	const program = new Command()
		.name(`dg-skills inbox ${usage}`)
		.description(spec.description)
		.helpOption("-h, --help", "display help for command");
	for (const name of helpFlagsFor(spec)) {
		const option = cliOptions.find((item) => item.flags.split(" ")[0] === name);
		if (!option) throw new Error(`unknown inbox help flag ${name}`);
		program.option(option.flags, option.description);
	}
	console.log(
		`${program.helpInformation().trimEnd()}\n\nAI output flags (--ai, --ai-summary, --ai-limit, --ai-fields, --ai-redacted) apply to JSON from this command.`,
	);
}
