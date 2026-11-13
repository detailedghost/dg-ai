import { type CompletionNode, type CompletionOption, oneLine, treeOf } from "@dg/common/completion";
import { PW_EXT_READ_VERBS, PW_EXT_WRITE_VERBS } from "@dg/common";
import { Command } from "commander";

type Shape = Pick<CompletionNode, "commands" | "options">;
type SpecLike = { subcommands: Record<string, { description?: string }> };
type FlagLike = { name: string; type: "string" | "boolean"; help: string };
type PwSpecLike = { name: string; help: string; flags: FlagLike[]; positionals: { name: string }[] };

const PATH_WORD = /path|file|dir|folder/i;
const described = (name: string, description?: string): CompletionNode => ({
	name,
	...(oneLine(description) ? { description: oneLine(description) } : {}),
});
const names = (list: Iterable<string>): Shape => ({ commands: [...list].map((name) => ({ name })) });

function fromSpec(spec: SpecLike): Shape {
	return {
		commands: Object.entries(spec.subcommands).map(([name, sub]) => described(name, sub.description)),
		options: [{ flags: ["--json"], description: "print JSON" }],
	};
}

function fromSubtree(register: (program: Command) => void): Shape {
	const root = new Command("dg-skills");
	register(root);
	const { commands, options } = treeOf(root.commands[0] as Command);
	return { ...(commands ? { commands } : {}), ...(options ? { options } : {}) };
}

function pwFlag(flag: FlagLike): CompletionOption {
	const value = flag.type === "boolean" ? undefined : PATH_WORD.test(flag.name) ? "path" : "any";
	const description = oneLine(flag.help);
	return { flags: [`--${flag.name}`], ...(description ? { description } : {}), ...(value ? { value } : {}) };
}

function fromPw(specs: readonly PwSpecLike[]): Shape {
	const ext = names([...PW_EXT_READ_VERBS, ...PW_EXT_WRITE_VERBS]);
	return {
		commands: specs.map((spec) => ({
			...described(spec.name, spec.help.split("\n")[0]),
			...(spec.flags.length ? { options: spec.flags.map(pwFlag) } : {}),
			...(spec.positionals.some((positional) => PATH_WORD.test(positional.name)) ? { path: true } : {}),
		})),
		options: [
			{ flags: ["--session", "-s"], description: "the browser session to use", value: "any" },
			{ flags: ["--raw"], description: "print only the result" },
			{ flags: ["--codegen"], description: "print the Playwright code for each step" },
			{ flags: ["--ext"], description: "drive the dg-ai-extension tab instead", mode: { name: "pw --ext", ...ext } },
		],
	};
}

/** Subcommands and flags of the commands that parse their own arguments, read from each feature's own tables. */
export async function shapes(): Promise<Record<string, Shape>> {
	const [stat, credentials, channelReview, bg, db, jot, testLive, vcs, address, worktree, spec, hooks, pw] = await Promise.all([
		import("../stat/cli"),
		import("../credentials/cli"),
		import("../channel-review/cli"),
		import("../bg/jobs"),
		import("../db"),
		import("../jot"),
		import("../test-live"),
		import("../vcs-provider"),
		import("../address"),
		import("../worktree"),
		import("../spec"),
		import("../hooks/cli"),
		import("../pw/commands"),
	]);
	return {
		stat: fromSubtree(stat.registerStat),
		credentials: fromSubtree((program) => credentials.registerCredentials(program)),
		"channel-review": fromSubtree(channelReview.registerChannelReview),
		bg: fromSpec(bg.bgSpec),
		db: fromSpec(db.dbSpec),
		jot: fromSpec(jot.jotSpec),
		"test-live": fromSpec(testLive.testLiveSpec),
		"vcs-provider": fromSpec(vcs.commandSpec),
		address: fromSpec(address.commandSpec),
		worktree: names(worktree.SUBCOMMANDS.keys()),
		spec: names(spec.HANDLERS.keys()),
		hooks: names([...hooks.COMMANDS, "run"]),
		pw: fromPw(pw.COMMANDS.map((entry) => entry.spec)),
	};
}

/** The dg-skills completion tree: every registered command, with the subcommands and flags of each. */
export async function skillsTree(): Promise<CompletionNode> {
	const [{ registerAll }, extra] = await Promise.all([import("../register-all"), shapes()]);
	const program = new Command("dg-skills").option("-V, --version", "output the version number").enablePositionalOptions();
	registerAll(program);
	const tree = treeOf(program);
	return { ...tree, commands: tree.commands?.map((node) => ({ ...node, ...extra[node.name] })) };
}
