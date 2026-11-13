import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type CompletionNode, treeOf } from "../pkg/common/src/completion";

const PKG = join(import.meta.dir, "..", "pkg");

const TREE_FILES = {
	"dg-skills": join(PKG, "skills-cli", "src", "completion", "tree.json"),
	"dg-agent": join(PKG, "dg-agent", "src", "completion-tree.json"),
	"dg-daemon": join(PKG, "dg-daemon", "src", "completion-tree.json"),
} as const;

type Program = keyof typeof TREE_FILES;

const BUILDERS: Record<Program, () => Promise<CompletionNode>> = {
	"dg-skills": async () => (await import("../pkg/skills-cli/src/completion/describe")).skillsTree(),
	"dg-agent": async () => treeOf(await (await import("../pkg/dg-agent/src/main")).buildProgram()),
	"dg-daemon": async () => treeOf(await (await import("../pkg/dg-daemon/src/main")).buildProgram()),
};

const treeText = (tree: CompletionNode): string => `${JSON.stringify(tree, null, "\t")}\n`;

const readOr = (path: string): string => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
};

if (import.meta.main) {
	const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), options: { check: { type: "boolean" } }, allowPositionals: true });
	const programs = (positionals.length ? positionals : Object.keys(TREE_FILES)) as Program[];
	let stale = 0;
	for (const program of programs) {
		const text = treeText(await BUILDERS[program]());
		const file = TREE_FILES[program];
		if (values.check) {
			if (readOr(file) === text) continue;
			stale += 1;
			console.error(`${file} is stale; run bun scripts/completion-trees.ts`);
		} else {
			writeFileSync(file, text);
			console.log(`wrote ${file}`);
		}
	}
	process.exitCode = stale === 0 ? 0 : 1;
}
