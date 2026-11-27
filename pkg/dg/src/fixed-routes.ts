import type { MountName } from "./main";

export interface FlatRoute {
	program: MountName;
	command: readonly string[];
}

export const GROUPS = {
	skills: { program: "dg-skills", description: "run a skills command by its full path: dg skills <command>" },
	agent: { program: "dg-agent", description: "run an agent session command: dg agent <command>" },
	daemon: { program: "dg-daemon", description: "run a daemon lifecycle command: dg daemon <command>" },
} as const satisfies Record<string, { program: MountName; description: string }>;

export const ALIASES = {
	upgrade: { program: "dg-skills", command: ["update"], description: "update every dg part (dg update)" },
	extension: { program: "dg-skills", command: ["install"], description: "stage the browser extension (dg install)" },
} as const satisfies Record<string, FlatRoute & { description: string }>;

/** The route of a group word or an alias, answered without the completion trees. */
export function fixedRoute(word: string): FlatRoute | undefined {
	if (Object.hasOwn(GROUPS, word)) return { program: GROUPS[word as keyof typeof GROUPS].program, command: [] };
	if (!Object.hasOwn(ALIASES, word)) return undefined;
	const { program, command } = ALIASES[word as keyof typeof ALIASES];
	return { program, command };
}
