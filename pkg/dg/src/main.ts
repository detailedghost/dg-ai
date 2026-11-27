import type { CompletionNode, CompletionShell } from "@dg/common/completion";
import type { ProgramName } from "@dg/common/node/program";
import type { FlatRoute } from "./fixed-routes";

export type MountName = Exclude<ProgramName, "dg">;

export type Mounts = Record<MountName, () => Promise<{ main(argv: string[]): Promise<number> }>>;

const SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish"];
const NAME_WIDTH = 20;
const AREAS: ReadonlyArray<readonly [MountName, string]> = [
	["dg-skills", "Skills commands"],
	["dg-agent", "Agent commands"],
	["dg-daemon", "Daemon commands"],
];

async function usage(): Promise<string> {
	const { ALIASES, flatRows, GROUPS, OWN } = await import("./flat");
	const row = (name: string, description: string) => `  ${name.padEnd(NAME_WIDTH)}${description}`;
	const rows = flatRows();
	const area = ([program, title]: readonly [MountName, string]) => [
		`${title}:`,
		...rows.filter((entry) => entry.program === program).map((entry) => row(entry.name, entry.description)),
		"",
	];
	return [
		"Usage: dg <command> [arguments]",
		"",
		...AREAS.flatMap(area),
		"Groups:",
		...Object.entries(GROUPS).map(([name, group]) => row(name, group.description)),
		"",
		"Aliases:",
		...Object.entries(ALIASES).map(([name, alias]) => row(name, alias.description)),
		"",
		"Other:",
		...Object.entries(OWN).map(([name, description]) => row(name, description)),
		"",
		"Run dg <command> --help for the options of one command.",
		"",
	].join("\n");
}

async function unknown(word: string): Promise<number> {
	const { groupedPaths } = await import("./flat");
	const paths = groupedPaths(word);
	process.stderr.write(
		paths.length > 0
			? `dg: "${word}" stays under its group; run ${paths.join(" or ")}\n`
			: `dg: unknown command "${word}"; run dg --help\n`,
	);
	return 1;
}

async function route(word: string | undefined): Promise<FlatRoute | undefined> {
	if (word === undefined) return undefined;
	const { fixedRoute } = await import("./fixed-routes");
	const fixed = fixedRoute(word);
	if (fixed) return fixed;
	const { resolveRoute } = await import("./flat");
	return resolveRoute(word);
}

async function runRoute(found: FlatRoute, args: readonly string[], mounts: Mounts, prefix: readonly string[] = []): Promise<number> {
	const { mountProgram } = await import("@dg/common/node/program");
	mountProgram(found.program);
	const { main } = await mounts[found.program]();
	return main([...prefix, ...found.command, ...args]);
}

async function completion(words: readonly string[], mounts: Mounts): Promise<number> {
	if (words.length > 1) {
		const [name, ...rest] = words;
		const found = await route(name);
		return found ? runRoute(found, rest, mounts, ["__complete"]) : 0;
	}
	const [{ printCompletions }, { ALIASES, flatRows, GROUPS, OWN }] = await Promise.all([
		import("@dg/common/completion"),
		import("./flat"),
	]);
	const root: CompletionNode = {
		name: "dg",
		commands: [
			...flatRows().map(({ name, description }) => ({ name, description })),
			...Object.entries(GROUPS).map(([name, group]) => ({ name, description: group.description })),
			...Object.entries(ALIASES).map(([name, alias]) => ({ name, description: alias.description })),
			...Object.entries(OWN).map(([name, description]) => ({ name, description })),
		],
	};
	return printCompletions(root, words.length ? words : [""]);
}

export async function main(argv: readonly string[], mounts: Mounts): Promise<number> {
	const [first, ...rest] = argv;
	const helpTopic = first === "help" && (rest.length === 0 || rest[0] === "help" || rest[0] === "completion");
	if (first === undefined || first === "--help" || first === "-h" || helpTopic) {
		process.stdout.write(await usage());
		return 0;
	}
	if (first === "--version") {
		const { buildVersion } = await import("@dg/common/build-version");
		process.stdout.write(`${buildVersion()}\n`);
		return 0;
	}
	if (first === "help") {
		const found = await route(rest[0]);
		return found ? runRoute(found, ["--help"], mounts) : unknown(rest[0] ?? "");
	}
	if (first === "completion") {
		const shell = rest[0];
		const known = SHELLS.find((candidate) => candidate === shell);
		if (!known) {
			process.stderr.write("dg: unknown shell; expected bash, zsh or fish\n");
			return 1;
		}
		const { completionScript } = await import("@dg/common/completion");
		process.stdout.write(completionScript(known, "dg"));
		return 0;
	}
	if (first === "__complete") return completion(rest, mounts);
	const found = await route(first);
	return found ? runRoute(found, rest, mounts) : unknown(first);
}
