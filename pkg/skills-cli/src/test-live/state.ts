import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { slugify } from "@dg/common";
import { statePath } from "@dg/common/node";
import type { TestLiveState } from "./types";

/** Slugify alone collides ("feature/foo" and "feature-foo" both slug to "feature-foo"); the hash disambiguates. */
function stateFileName(branch: string): string {
	const hash = createHash("sha1").update(branch).digest("hex").slice(0, 8);
	return `${slugify(branch)}-${hash}.json`;
}

/** Project-scoped (shared across linked worktrees) and branch-scoped, so two repos or two branches never collide. */
export function testLiveStatePath(branch: string): string {
	return statePath("test-live", stateFileName(branch));
}

export function readTestLiveState(branch: string): TestLiveState | null {
	const path = testLiveStatePath(branch);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as TestLiveState;
}

export function writeTestLiveState(state: TestLiveState): void {
	writeFileSync(testLiveStatePath(state.branch), JSON.stringify(state, null, "\t"));
}

export function removeTestLiveState(branch: string): void {
	const path = testLiveStatePath(branch);
	if (existsSync(path)) unlinkSync(path);
}
