/**
 * Static smoke tests: the plugin manifest and every SKILL.md point at the
 * packages/paths that actually exist after the monorepo restructure, and the
 * CLI-invoking skills run the compiled dg-skills binary (not the TS source).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SKILLS_DIR = join(REPO_ROOT, "pkg", "skills");

const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
	.filter((d) => d.isDirectory())
	.map((d) => d.name);

/** Every markdown file under pkg/skills. */
function markdownFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
		else if (entry.endsWith(".md")) out.push(p);
	}
	return out;
}

describe("plugin.json", () => {
	const plugin = JSON.parse(
		readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
	);

	test("skills is an array of ./-prefixed paths", () => {
		expect(Array.isArray(plugin.skills)).toBe(true);
		for (const p of plugin.skills) expect(p.startsWith("./")).toBe(true);
	});

	test("skills points at the real, existing pkg/skills dir", () => {
		expect(plugin.skills).toContain("./pkg/skills");
		expect(existsSync(SKILLS_DIR)).toBe(true);
	});
});

describe("each skill directory", () => {
	test("there is at least one skill", () => {
		expect(skillDirs.length).toBeGreaterThan(0);
	});

	for (const name of skillDirs) {
		test(`${name}/ has a SKILL.md`, () => {
			expect(existsSync(join(SKILLS_DIR, name, "SKILL.md"))).toBe(true);
		});
	}
});

describe("no stale post-restructure paths in pkg/skills", () => {
	for (const file of markdownFiles(SKILLS_DIR)) {
		const rel = relative(REPO_ROOT, file);
		test(rel, () => {
			const txt = readFileSync(file, "utf8");
			// removed in the restructure — must not linger anywhere
			expect(txt).not.toContain("skills/browser/bin");
			expect(txt).not.toContain("extension-src");
		});
	}
});

describe("CLI-invoking SKILL.md uses the compiled binary", () => {
	for (const name of skillDirs) {
		const md = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
		if (!md.includes("dg-skills")) continue; // non-CLI skill

		test(`${name}: invokes ~/.dg/bin/dg-skills`, () => {
			expect(md).toContain(".dg/bin/dg-skills");
		});
		test(`${name}: bootstraps via bootstrap.sh`, () => {
			expect(md).toContain("skills-cli/bootstrap.sh");
		});
		test(`${name}: does not run the TS source entrypoint`, () => {
			expect(md).not.toContain("src/index.ts");
		});
	}
});
