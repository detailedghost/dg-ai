import { parseArgs } from "node:util";
import { commandHelp } from "./help";
import type { CommandSpec, ParsedArgs } from "./spec";

export const MULTIPLE_SEPARATOR = "\n";

const NEGATIVE_NUMBER = /^-\d+(?:\.\d+)?$/;
const NUMBER_MARK = "\u0000";
const unmarkNumber = (value: string): string =>
	value.startsWith(NUMBER_MARK) ? value.slice(1) : value;

export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

const GLOBAL_OPTIONS = {
	session: { type: "string" },
	raw: { type: "boolean" },
	codegen: { type: "boolean" },
	help: { type: "boolean" },
	version: { type: "boolean" },
} as const;

export class UsageError extends Error {
	readonly exitCode = 2;
}

export function normalize(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--") {
			out.push(...argv.slice(i));
			break;
		}
		if (arg === "-s") {
			throw new UsageError(
				"-s needs a value: use -s=<name>. For an ephemeral browser use --scratch.",
			);
		}
		if (arg.startsWith("-s=")) out.push(`--session=${arg.slice(3)}`);
		else if (arg === "--session" && i + 1 < argv.length)
			out.push(`--session=${argv[++i]}`);
		else out.push(arg);
	}
	return out;
}

/** The arguments before the -- terminator, where flags and the command name live. */
export function optionArgs(argv: readonly string[]): readonly string[] {
	const end = argv.indexOf("--");
	return end === -1 ? argv : argv.slice(0, end);
}

export function commandName(argv: readonly string[]): string | undefined {
	return optionArgs(argv).find((arg) => !arg.startsWith("-"));
}

function usageFailure(message: string, spec: CommandSpec): UsageError {
	return new UsageError(`${message}\n\n${commandHelp(spec)}`);
}

export function parse(argv: readonly string[], spec: CommandSpec): ParsedArgs {
	const options: Record<
		string,
		{ type: "string" | "boolean"; multiple?: boolean }
	> = { ...GLOBAL_OPTIONS };
	for (const flag of spec.flags)
		options[flag.name] = {
			type: flag.type,
			...(flag.multiple ? { multiple: true } : {}),
		};

	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs({
			args: normalize(argv).map((arg) =>
				NEGATIVE_NUMBER.test(arg) ? `${NUMBER_MARK}${arg}` : arg,
			),
			options,
			allowPositionals: true,
			strict: true,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const unknown = message.match(/^Unknown option '([^']+)'/);
		throw usageFailure(
			unknown ? `Unknown option: ${unknown[1]}` : message,
			spec,
		);
	}

	const [, ...positionals] = parsed.positionals.map(unmarkNumber);
	const required = spec.positionals.filter((p) => p.required);
	if (positionals.length < required.length) {
		const missing = required[positionals.length] as { name: string };
		throw usageFailure(`Missing argument: <${missing.name}>`, spec);
	}
	const variadic = spec.positionals.some((p) => p.variadic);
	if (!variadic && positionals.length > spec.positionals.length) {
		throw usageFailure(
			`Unexpected argument: ${positionals[spec.positionals.length]}`,
			spec,
		);
	}

	const session = String(
		parsed.values["session"] ??
			process.env["PLAYWRIGHT_CLI_SESSION"] ??
			"default",
	);
	if (!SESSION_NAME.test(session) || session.includes("..")) {
		throw usageFailure(
			`Invalid session name '${session}': use letters, digits, '.', '_' or '-'`,
			spec,
		);
	}

	const flags: Record<string, string | boolean> = {};
	for (const flag of spec.flags) {
		const value = parsed.values[flag.name];
		if (value === undefined) continue;
		flags[flag.name] = Array.isArray(value)
			? (value as string[]).map(unmarkNumber).join(MULTIPLE_SEPARATOR)
			: typeof value === "string"
				? unmarkNumber(value)
				: (value as boolean);
	}

	return {
		session,
		command: spec.name,
		positionals,
		flags,
		raw: parsed.values["raw"] === true,
		codegen: parsed.values["codegen"] === true,
	};
}

export function stringFlag(args: ParsedArgs, name: string): string | undefined {
	const value = args.flags[name];
	return typeof value === "string" ? value : undefined;
}
