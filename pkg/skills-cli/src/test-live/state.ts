import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { slugify } from "@dg/common";
import { statePath } from "@dg/common/node";
import { TestLiveError } from "./shared";
import type { TestLiveState } from "./types";

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isTestLiveState(value: unknown): value is TestLiveState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	return (
		typeof state.branch === "string" &&
		typeof state.env === "string" &&
		typeof state.workflowFile === "string" &&
		typeof state.workflowPath === "string" &&
		typeof state.patched === "boolean" &&
		isNullableString(state.patchCommitSha) &&
		isNullableString(state.prePatchSha) &&
		isNullableString(state.runUrl) &&
		isNullableString(state.runId) &&
		typeof state.createdAt === "string"
	);
}

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
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new TestLiveError(
			`test-live state file at ${path} is corrupt: ${error instanceof Error ? error.message : String(error)} — inspect or delete it`,
		);
	}
	if (!isTestLiveState(parsed)) {
		throw new TestLiveError(`test-live state file at ${path} does not match the expected shape — inspect or delete it`);
	}
	return parsed;
}

export function writeTestLiveState(state: TestLiveState): void {
	writeFileSync(testLiveStatePath(state.branch), JSON.stringify(state, null, "\t"));
}

export function removeTestLiveState(branch: string): void {
	const path = testLiveStatePath(branch);
	if (existsSync(path)) unlinkSync(path);
}
