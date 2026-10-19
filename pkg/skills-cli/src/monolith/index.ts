import { defineCommand } from "../utils/legacy-command";
import { HELPER_VERBS } from "./helper";
import { worktreeGen } from "./worktree-gen";

const dispatcher = defineCommand({
	name: "monolith",
	description: "Deterministic helper for the /monolith skill",
	subcommands: {
		...HELPER_VERBS,
		"worktree-gen": {
			description: "Emit a worktree-scoped scan.workflow.mjs for /monolith",
			args: ["WORKTREE_PATH", "[--mode MODE]", "[--out FILE]"],
			run: async (args) => worktreeGen(args),
		},
	},
});

/** Run helper verbs or the generator. */
export async function main(argv: string[]): Promise<number | undefined> {
	if (argv[0] === "worktree-gen") return worktreeGen(argv.slice(1));
	return (await dispatcher.run(argv)) ?? undefined;
}
