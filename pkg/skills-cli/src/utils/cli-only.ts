import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import type { Command } from "commander";
import { cliDest } from "./lib";

export const EXT_ONLY_COMMANDS = ["launch"];

export const cliOnlyMarker = (): string => resolveDgPaths().cliOnlyMarker;

export const isCliOnly = (): boolean => existsSync(cliOnlyMarker());

export function setCliOnly(enabled: boolean): void {
	const marker = cliOnlyMarker();
	if (!enabled) return rmSync(marker, { force: true });
	mkdirSync(dirname(marker), { recursive: true });
	writeFileSync(marker, "");
}

export function extensionRequiredMessage(subject: string): string {
	const toAdd = existsSync(cliDest("dg-agent"))
		? "the extension and dg-daemon"
		: "the extension, dg-daemon and dg-agent";
	return `${subject} needs the dg-ai-extension, but this is a CLI-only install. Run "dg-skills install" to add ${toAdd}.`;
}

export function assertExtensionInstalled(subject: string): void {
	if (isCliOnly()) throw new Error(extensionRequiredMessage(subject));
}

function extRequested(command: Command | null): boolean {
	return command
		? (command.opts() as { ext?: boolean }).ext === true ||
				extRequested(command.parent)
		: false;
}

function topLevelName(command: Command): string {
	return command.parent?.parent ? topLevelName(command.parent) : command.name();
}

export function guardExtensionCommands(program: Command): void {
	program.hook("preAction", (_program, action) => {
		const name = topLevelName(action);
		if (EXT_ONLY_COMMANDS.includes(name) || extRequested(action)) {
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
