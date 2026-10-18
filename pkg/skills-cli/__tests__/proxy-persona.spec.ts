import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePersona, withPersona } from "../src/proxy/persona";

// resolvePersona's subagent path reads real files off $HOME/.claude/agents,
// so each test gets its own scratch HOME instead of touching the real one.
let scratchHome: string;
let originalHome: string | undefined;
let originalPath: string | undefined;

beforeEach(() => {
	scratchHome = mkdtempSync(join(tmpdir(), "persona-test-"));
	originalHome = process.env.HOME;
	originalPath = process.env.PATH;
	process.env.HOME = scratchHome;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	rmSync(scratchHome, { recursive: true, force: true });
});

function writeAgentPersona(name: string, content: string): void {
	const dir = join(scratchHome, ".claude/agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${name}.md`), content);
}

describe("withPersona", () => {
	test("returns the prompt unchanged when persona is null", () => {
		expect(withPersona(null, "do the thing")).toBe("do the thing");
	});

	test("wraps the prompt with the persona briefing template", () => {
		const result = withPersona("You are a careful reviewer.", "fix the bug");
		expect(result).toBe(
			"You are being briefed to act as the following specialized role:\n\n" +
				"You are a careful reviewer.\n\n---\nTask:\nfix the bug",
		);
	});

	// empty string is falsy but !== null, so it must still be treated as a real persona
	test("treats an empty-string persona as present, not absent", () => {
		const result = withPersona("", "fix the bug");
		expect(result).toContain("---\nTask:\nfix the bug");
		expect(result.startsWith("You are being briefed")).toBe(true);
	});
});

describe("resolvePersona", () => {
	test("returns null when neither subagent nor spec/slice are given", async () => {
		expect(await resolvePersona({})).toBeNull();
	});

	test("returns null when only spec is given without a slice", async () => {
		expect(await resolvePersona({ spec: "042_thing" })).toBeNull();
	});

	test("returns null when only slice is given without a spec", async () => {
		expect(await resolvePersona({ slice: "slice-1" })).toBeNull();
	});

	test("reads the named agent persona file under ~/.claude/agents", async () => {
		writeAgentPersona("reviewer", "# Reviewer\nBe thorough.");
		const result = await resolvePersona({ subagent: "reviewer" });
		expect(result).toBe("# Reviewer\nBe thorough.");
	});

	test("throws a descriptive error when the named agent file is missing", async () => {
		await expect(resolvePersona({ subagent: "ghost-agent" })).rejects.toThrow(/Agent persona not found: ghost-agent/);
	});

	test("prefers subagent over spec/slice when both are supplied", async () => {
		writeAgentPersona("primary-role", "primary content");
		const result = await resolvePersona({
			subagent: "primary-role",
			spec: "042_thing",
			slice: "slice-1",
		});
		expect(result).toBe("primary content");
	});

	test("reads numeric and string slice ids from an explicit plan without spec-cli", async () => {
		writeAgentPersona("reviewer", "review role");
		const plan = join(scratchHome, "plan with spaces.md");
		writeFileSync(plan, "---\nslices:\n  - id: 1\n    agents:\n      primary: reviewer\n  - id: 'second'\n    agents:\n      primary: reviewer\n---\n# Plan\n");
		expect(await resolvePersona({ spec: plan, slice: "1" })).toBe("review role");
		expect(await resolvePersona({ spec: plan, slice: "second" })).toBe("review role");
	});

	test("throws a useful error when the requested slice is missing", async () => {
		const plan = join(scratchHome, "plan.md");
		writeFileSync(plan, "---\nslices:\n  - id: 1\n---\n");
		await expect(resolvePersona({ spec: plan, slice: "missing" })).rejects.toThrow(/Slice not found.*missing/);
	});

	test("returns null when a matching slice has no primary agent", async () => {
		const plan = join(scratchHome, "plan.md");
		writeFileSync(plan, "---\nslices:\n  - id: 1\n    agents: {}\n---\n");
		expect(await resolvePersona({ spec: plan, slice: "1" })).toBeNull();
	});
});
