import { die } from "../spec/shared";
import { repoRoot, requireInitialized } from "./paths";

export function lintCommand(_args: string[]): number {
	requireInitialized(repoRoot());
	return die("lint: not implemented");
}
