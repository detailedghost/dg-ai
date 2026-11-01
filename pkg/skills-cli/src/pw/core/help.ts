import type { CommandGroup, CommandSpec } from "./spec";

const GROUP_ORDER: CommandGroup[] = [
	"core",
	"navigation",
	"keyboard",
	"mouse",
	"tabs",
	"storage",
	"network",
	"devtools",
	"session",
	"state",
];

export const GLOBAL_HELP = [
	"  -s=<name>, --session=<name>  session name (default: default, or PLAYWRIGHT_CLI_SESSION)",
	"  --raw                        print only the result value",
	"  --codegen                    include the Playwright code that ran",
	"  --help                       show help",
	"  --version                    show version",
];

function usageLine(spec: CommandSpec): string {
	const positionals = spec.positionals.map((p) => {
		const name = p.variadic ? `${p.name}...` : p.name;
		return p.required ? `<${name}>` : `[${name}]`;
	});
	return [spec.name, ...positionals].join(" ");
}

export function commandHelp(spec: CommandSpec): string {
	const lines = [`pw ${usageLine(spec)}`, "", spec.help];
	if (spec.flags.length > 0) {
		lines.push("", "Options:");
		for (const flag of spec.flags) {
			const name =
				flag.type === "string" ? `--${flag.name}=<value>` : `--${flag.name}`;
			const note = flag.multiple ? " (repeatable)" : "";
			lines.push(`  ${name.padEnd(24)}${flag.help}${note}`);
		}
	}
	lines.push("", "Global options:", ...GLOBAL_HELP);
	return lines.join("\n");
}

export function indexHelp(specs: readonly CommandSpec[]): string {
	const lines = [
		"Usage: pw [-s=<session>] <command> [args] [options]",
		"",
		"Global options:",
		...GLOBAL_HELP,
	];
	const width = Math.max(
		30,
		...specs.map((spec) => usageLine(spec).length + 2),
	);
	for (const group of GROUP_ORDER) {
		const inGroup = specs.filter((s) => s.group === group);
		if (inGroup.length === 0) continue;
		lines.push("", `${group}:`);
		for (const spec of inGroup)
			lines.push(
				`  ${usageLine(spec).padEnd(width)}${spec.help.split("\n")[0]}`,
			);
	}
	return lines.join("\n");
}
