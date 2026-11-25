import { type CompletionNode, completeWords } from "@dg/common/completion";
import tree from "./tree.json" with { type: "json" };

/** Candidate lines for `__complete`, answered from tree.json without building the command tree. */
export function completeFast(words: readonly string[]): string[] {
	return completeWords(tree as CompletionNode, words);
}
