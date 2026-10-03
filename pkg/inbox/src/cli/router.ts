import type { CliContext } from "./context";
import { commandHelpText, createHelpProgram } from "./args";

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
