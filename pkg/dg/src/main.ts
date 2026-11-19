import type { CompletionNode, CompletionShell } from "@dg/common/completion";
import type { ProgramName } from "@dg/common/node/program";

export type MountName = Exclude<ProgramName, "dg">;

export type Mounts = Record<MountName, () => Promise<{ main(argv: string[]): Promise<number> }>>;

interface Route {
	program: MountName;
	command: readonly string[];
	description: string;
}

export const ROUTES = {
	job: { program: "dg-daemon", command: ["job"], description: "schedule and run recurring jobs (runs dg-daemon job)" },
	autostart: { program: "dg-daemon", command: ["autostart"], description: "start the daemon when you log in (runs dg-daemon autostart)" },
	daemon: { program: "dg-daemon", command: [], description: "run the dg-daemon program (runs dg-daemon)" },
	skills: { program: "dg-skills", command: [], description: "run the dg-skills program (runs dg-skills)" },
	agent: { program: "dg-agent", command: [], description: "run the dg-agent program (runs dg-agent)" },
	extension: {
		program: "dg-skills",
		command: ["install"],
		description: "stage the browser extension (runs dg-skills install)",
	},
	install: {
		program: "dg-skills",
		command: ["install"],
		description: "install the dg skills and the browser extension (runs dg-skills install)",
	},
	upgrade: { program: "dg-skills", command: ["update"], description: "update the dg skills (runs dg-skills update)" },
	doctor: { program: "dg-skills", command: ["doctor"], description: "check the dg install (runs dg-skills doctor)" },
} as const satisfies Record<string, Route>;

type RouteName = keyof typeof ROUTES;

const SHELLS: readonly CompletionShell[] = ["bash", "zsh", "fish"];
const EXTRAS = [
	{ name: "completion", description: "print the bash, zsh or fish completion script" },
	{ name: "help", description: "show help for dg or for one command" },
] as const;
const NAME_WIDTH = 12;

const isRoute = (name: string | undefined): name is RouteName => name !== undefined && Object.hasOwn(ROUTES, name);

function usage(): string {
	const row = (name: string, description: string) => `  ${name.padEnd(NAME_WIDTH)}${description}`;
	return [
		"Usage: dg <command> [arguments]",
		"",
		"Commands:",
		...Object.entries(ROUTES).map(([name, route]) => row(name, route.description)),
		row("completion", "print the bash, zsh or fish completion script (dg completion <shell>)"),
		"",
		"Run dg <command> --help for the options of one command.",
		"",
	].join("\n");
}

function unknown(word: string): number {
	process.stderr.write(`dg: unknown command "${word}"; run dg --help\n`);
	return 1;
}

async function runRoute(
	name: RouteName,
	args: readonly string[],
	mounts: Mounts,
	prefix: readonly string[] = [],
): Promise<number> {
	const route: Route = ROUTES[name];
	const { mountProgram } = await import("@dg/common/node/program");
	mountProgram(route.program);
	const { main } = await mounts[route.program]();
	return main([...prefix, ...route.command, ...args]);
}

async function completion(words: readonly string[], mounts: Mounts): Promise<number> {
	if (words.length > 1) {
		const [name, ...rest] = words;
		return isRoute(name) ? runRoute(name, rest, mounts, ["__complete"]) : 0;
	}
	const { printCompletions } = await import("@dg/common/completion");
	const root: CompletionNode = {
		name: "dg",
		commands: [
			...Object.entries(ROUTES).map(([name, route]) => ({ name, description: route.description })),
			...EXTRAS,
		],
	};
	return printCompletions(root, words.length ? words : [""]);
}

export async function main(argv: readonly string[], mounts: Mounts): Promise<number> {
	const [first, ...rest] = argv;
	const helpTopic = first === "help" && (rest.length === 0 || rest[0] === "help" || rest[0] === "completion");
	if (first === undefined || first === "--help" || first === "-h" || helpTopic) {
		process.stdout.write(usage());
		return 0;
	}
	if (first === "--version") {
		process.stdout.write(`${process.env.DG_BUILD_VERSION ?? "dev"}\n`);
		return 0;
	}
	if (first === "help") return isRoute(rest[0]) ? runRoute(rest[0], ["--help"], mounts) : unknown(rest[0] ?? "");
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
	return isRoute(first) ? runRoute(first, rest, mounts) : unknown(first);
}
