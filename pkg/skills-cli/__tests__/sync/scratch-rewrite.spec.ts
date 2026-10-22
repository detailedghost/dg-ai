import { describe, expect, test } from "bun:test";
import { rewriteScratchPaths } from "../../src/sync/scratch-rewrite";

describe("rewriteScratchPaths", () => {
	test("rewrites every known tool-specific scratch root to AI_SCRATCH_DIR", () => {
		const env = { AI_SCRATCH_DIR: "/custom/scratch" };
		for (const root of ["/tmp/ai", "/tmp/claude", "/tmp/codex", "/tmp/copilot", "/tmp/opencode", "/tmp/pi"]) {
			expect(rewriteScratchPaths(`${root}/output.txt`, env)).toBe("/custom/scratch/output.txt");
		}
	});

	test("defaults to /tmp/ai when AI_SCRATCH_DIR is unset", () => {
		expect(rewriteScratchPaths("/tmp/claude/x", {})).toBe("/tmp/ai/x");
	});

	test("rewrites both tilde and $HOME forms of the state root", () => {
		const env = { AI_STATE_DIR: "/custom/state" };
		expect(rewriteScratchPaths("~/.local/state/ai/notes", env)).toBe("/custom/state/notes");
		expect(rewriteScratchPaths("$HOME/.local/state/ai/notes", env)).toBe("/custom/state/notes");
	});

	test("rewrites state before scratch, so a scratch literal embedded in the configured state root is also normalized", () => {
		const env = { AI_STATE_DIR: "/tmp/ai/state", AI_SCRATCH_DIR: "/elsewhere" };
		expect(rewriteScratchPaths("~/.local/state/ai/notes", env)).toBe("/elsewhere/state/notes");
	});

	test("leaves unrelated text untouched", () => {
		expect(rewriteScratchPaths("no scratch paths here", {})).toBe("no scratch paths here");
	});

	test("is idempotent", () => {
		const env = { AI_SCRATCH_DIR: "/custom/scratch" };
		const once = rewriteScratchPaths("/tmp/claude/x", env);
		expect(rewriteScratchPaths(once, env)).toBe(once);
	});
});
