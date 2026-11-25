import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { completeFast } from "../pkg/skills-cli/src/completion/fast";
import tree from "../pkg/skills-cli/src/completion/tree.json" with { type: "json" };

export const OUT_DIR = join(import.meta.dir, "..", "native", "src", "Dg.Completion", "bin", "completion");

export const PARITY_WORDS: string[][] = [
	[""],
	["st"],
	["stat", "ch"],
	["credentials", "re"],
	["pw", "--ext", "sn"],
	["pw", "--ext", "--tab", "42", "sn"],
	["completion", "--in"],
	["completion", "f"],
	["adr", ""],
	["adr", "re"],
	["adr", "relevant", ""],
	["--"],
	["--he"],
	["no-such-command", ""],
	["stat", "--", "ch"],
	["channel-review", "emojis", "capture", "--slot", ""],
	["channel-review", "emojis", "capture", "--slot=ap"],
	["channel-review", "emojis", "set", ""],
	["pw", "--ext", "--session=x", "--t"],
];

export function writeNativeCompletion(outDir: string = OUT_DIR): void {
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "tree.json"), JSON.stringify(tree));
	const cases = PARITY_WORDS.map((words) => ({ words, candidates: completeFast(words) }));
	writeFileSync(join(outDir, "parity.json"), JSON.stringify(cases));
}

if (import.meta.main) writeNativeCompletion(process.argv[2]);
