import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";

export const EXTENSION_COMMANDS = [
	"batch-open",
	"launch",
	"demo",
	"rerun",
];

export const cliOnlyMarker = (): string =>
	join(process.env.DG_HOME ?? join(homedir(), ".dg"), "cli-only");

export const isCliOnly = (): boolean => existsSync(cliOnlyMarker());

export function setCliOnly(enabled: boolean): void {
	const marker = cliOnlyMarker();
	if (!enabled) return rmSync(marker, { force: true });
	mkdirSync(dirname(marker), { recursive: true });
	writeFileSync(marker, "");
}

export function extensionRequiredMessage(subject: string): string {
	return `${subject} needs the dg-ai-extension, but this is a CLI-only install. Run "dg-skills install" to add the extension, dg-daemon and dg-agent.`;
}

export function assertExtensionInstalled(subject: string): void {
	if (isCliOnly()) throw new Error(extensionRequiredMessage(subject));
}

function topLevelName(command: Command): string {
	return command.parent?.parent ? topLevelName(command.parent) : command.name();
}

export function guardExtensionCommands(program: Command): void {
	program.hook("preAction", (_program, action) => {
		const name = topLevelName(action);
		if (EXTENSION_COMMANDS.includes(name)) {
			assertExtensionInstalled(`dg-skills ${name}`);
		}
	});
}

export function registerRequireExtension(program: Command): void {
	program
		.command("require-extension")
		.description(
			"exit non-zero with a hint when this is a CLI-only install (used by skills that need the extension)",
		)
		.argument("<skill>", "name of the skill that needs the extension")
		.action((skill: string) => {
			assertExtensionInstalled(`The ${skill} skill`);
		});
}
