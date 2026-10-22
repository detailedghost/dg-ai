import { UsageError } from "../../core/args";
import { CONSOLE_LEVELS, type ConsoleLevel, levelOf, meetsLevel } from "../../core/events";
import type { DaemonHandler } from "../../core/spec";

const ENTRY_MAX = 2000;

export function parseLevel(value: string | undefined): ConsoleLevel {
	if (value === undefined) return "info";
	const match = CONSOLE_LEVELS.find((level) => level === value);
	if (!match) throw new UsageError(`Invalid level '${value}': use ${CONSOLE_LEVELS.join(", ")}`);
	return match;
}

const consoleCommand: DaemonHandler = async (ctx, args) => {
	const level = parseLevel(args.positionals[0]);
	const page = ctx.page();
	const all = ctx.events.console(page);
	const shown = all.filter((entry) => meetsLevel(entry, level));
	const errors = all.filter((entry) => levelOf(entry.type) === "error").length;
	const warnings = all.filter((entry) => levelOf(entry.type) === "warning").length;
	const lines = [`Total messages: ${all.length} (Errors: ${errors}, Warnings: ${warnings})`];
	if (shown.length !== all.length) lines.push(`Returning ${shown.length} messages for level "${level}"`);
	if (shown.length > 0) lines.push("");
	for (const entry of shown) lines.push(`[${entry.type.toUpperCase()}] ${entry.text.slice(0, ENTRY_MAX)}`);
	if (args.flags["clear"] === true) ctx.events.clearConsole(page);
	return { result: lines.join("\n"), code: "await page.consoleMessages();" };
};

export default consoleCommand;
