import { describe, expect, test } from "bun:test";
import { transformSkillText } from "../../src/sync/skill-transform";

describe("transformSkillText", () => {
	test("rewrites scratch paths and keeps only recognized frontmatter fields", () => {
		const src = [
			"---",
			"name: demo",
			"description: Create demo assets.",
			"allowed-tools: Bash(demo:*)",
			"user-invocable: true",
			"---",
			"",
			"Write output to `/tmp/claude/demo/`.",
			"",
		].join("\n");
		const r = transformSkillText(src);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.content).toContain("/tmp/ai/demo/");
		expect(r.content).not.toContain("/tmp/claude");
		expect(r.content).not.toContain("allowed-tools");
		expect(r.content).not.toContain("user-invocable");
		expect(r.content).toContain("name: demo");
		expect(r.content).toContain("description: Create demo assets.");
	});

	test("preserves license, compatibility, and metadata fields when present", () => {
		const src = [
			"---",
			"name: licensed",
			"description: Has extra recognized fields.",
			"license: MIT",
			"compatibility: opencode",
			"---",
			"",
			"Body.",
			"",
		].join("\n");
		const r = transformSkillText(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.content).toContain("license: MIT");
			expect(r.content).toContain("compatibility: opencode");
		}
	});

	test("fails when there is no frontmatter", () => {
		const r = transformSkillText("# No frontmatter\n\nJust a body.\n");
		expect(r.ok).toBe(false);
	});

	test("fails when frontmatter is missing name or description", () => {
		const r = transformSkillText("---\nname: onlyname\n---\nBody.\n");
		expect(r.ok).toBe(false);
	});

	test("quotes a description value containing YAML-significant characters", () => {
		const src = ["---", 'name: tricky', "description: 'Has: a colon and # a hash'", "---", "", "Body.", ""].join("\n");
		const r = transformSkillText(src);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.content).toContain('description: "Has: a colon and # a hash"');
	});

	test("preserves the body exactly, including code fences", () => {
		const src = ["---", "name: body-test", "description: Body fidelity.", "---", "", "```bash", "echo hi", "```", ""].join("\n");
		const r = transformSkillText(src);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.content).toContain("```bash");
			expect(r.content).toContain("echo hi");
		}
	});
});
