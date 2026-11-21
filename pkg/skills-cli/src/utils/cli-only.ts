import { existsSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { readDgToml, writeDgToml } from "@dg/common/node/dg-toml";
import { migrateToTomlSync } from "@dg/common/node/dg-toml-migrate";
import { assertEntryMoved } from "./layout-guard";
import type { Command } from "commander";
import { cliDest } from "./lib";

export function isCliOnly(): boolean {
	return readDgToml().install.cli_only;
}

export function setCliOnly(enabled: boolean): void {
	assertEntryMoved("cli-only");
	migrateToTomlSync(resolveDgPaths());
	writeDgToml("install.cli_only", enabled);
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
		if (extRequested(action))
			assertExtensionInstalled(`dg-skills ${topLevelName(action)}`);
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
