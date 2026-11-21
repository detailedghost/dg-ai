import agentTree from "../../dg-agent/src/completion-tree.json" with { type: "json" };
import daemonTree from "../../dg-daemon/src/completion-tree.json" with { type: "json" };
import skillsTree from "../../skills-cli/src/completion/tree.json" with { type: "json" };
import type { MountName } from "./main";

export interface FlatRoute {
	program: MountName;
	command: readonly string[];
}

interface Row extends FlatRoute {
	name: string;
	description: string;
}

interface Tree {
	commands?: ReadonlyArray<{ name: string; description?: string }>;
}

export type Trees = Record<MountName, Tree>;

const TREES: Trees = { "dg-skills": skillsTree, "dg-agent": agentTree, "dg-daemon": daemonTree };

export const GROUPS = {
	skills: { program: "dg-skills", description: "run a skills command by its full path: dg skills <command>" },
	agent: { program: "dg-agent", description: "run an agent session command: dg agent <command>" },
	daemon: { program: "dg-daemon", description: "run a daemon lifecycle command: dg daemon <command>" },
} as const satisfies Record<string, { program: MountName; description: string }>;

export const GROUPED: Readonly<Record<MountName, readonly string[]>> = {
	"dg-skills": [],
	"dg-agent": ["start", "send", "recv", "progress", "spawn", "stage", "close", "manifest"],
	"dg-daemon": ["serve", "status", "start", "stop", "restart", "sessions", "origin"],
};

export const OWNERS: Readonly<Record<string, MountName>> = {};

export const ALIASES = {
	upgrade: { program: "dg-skills", command: ["update"], description: "update every dg part (dg update)" },
	extension: { program: "dg-skills", command: ["install"], description: "stage the browser extension (dg install)" },
} as const satisfies Record<string, FlatRoute & { description: string }>;

export const OWN = {
	completion: "print the bash, zsh or fish completion script (dg completion <shell>)",
	help: "show help for dg or for one command",
} as const;

const GROUP_ORDER: readonly MountName[] = ["dg-skills", "dg-agent", "dg-daemon"];
const reserved = (name: string): boolean => Object.hasOwn(GROUPS, name) || Object.hasOwn(ALIASES, name) || Object.hasOwn(OWN, name);

function candidates(trees: Trees): Map<string, Row[]> {
	const found = new Map<string, Row[]>();
	for (const program of GROUP_ORDER) {
		for (const { name, description } of trees[program].commands ?? []) {
			if (name === "completion" || GROUPED[program].includes(name)) continue;
			const rows = found.get(name) ?? [];
			rows.push({ name, program, command: [name], description: (description ?? "").replace(/\s+/g, " ").trim() });
			found.set(name, rows);
		}
	}
	return found;
}

/** Each flat name that two places claim and that no table settles, with the programs that claim it. */
export function collisions(trees: Trees = TREES): { name: string; programs: string[] }[] {
	return [...candidates(trees)].flatMap(([name, rows]) => {
		if (reserved(name)) return [{ name, programs: ["dg", ...rows.map((row) => row.program)] }];
		if (rows.length < 2 || Object.hasOwn(OWNERS, name)) return [];
		return [{ name, programs: rows.map((row) => row.program) }];
	});
}

function table(trees: Trees): Map<string, Row> {
	const rows = new Map<string, Row>();
	for (const [name, claims] of candidates(trees)) {
		if (reserved(name)) continue;
		const owner = Object.hasOwn(OWNERS, name) ? OWNERS[name] : claims.length === 1 ? claims[0]?.program : undefined;
		const row = claims.find((claim) => claim.program === owner);
		if (row) rows.set(name, row);
	}
	return rows;
}

let cached: Map<string, Row> | undefined;
const flatTable = (): Map<string, Row> => {
	cached ??= table(TREES);
	return cached;
};

/** The flat rows in help order: skills, then agent, then daemon. */
export function flatRows(): Row[] {
	return [...flatTable().values()];
}

export function resolveRoute(word: string): FlatRoute | undefined {
	if (Object.hasOwn(GROUPS, word)) return { program: GROUPS[word as keyof typeof GROUPS].program, command: [] };
	if (Object.hasOwn(ALIASES, word)) {
		const { program, command } = ALIASES[word as keyof typeof ALIASES];
		return { program, command };
	}
	const row = flatTable().get(word);
	return row && { program: row.program, command: row.command };
}

const GROUP_WORD: Record<MountName, string> = { "dg-skills": "skills", "dg-agent": "agent", "dg-daemon": "daemon" };

/** The full paths of a name that stays under a group, such as `dg daemon start` and `dg agent start`. */
export function groupedPaths(word: string): string[] {
	return GROUP_ORDER.filter((program) => GROUPED[program].includes(word)).map((program) => `dg ${GROUP_WORD[program]} ${word}`);
}
