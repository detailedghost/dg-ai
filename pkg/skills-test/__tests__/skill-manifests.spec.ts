/**
 * Static smoke tests: both plugin hosts point at one canonical skill tree, and
 * the CLI-invoking skills can bootstrap without a host-specific environment.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CODEX_PLUGIN_DIR = join(REPO_ROOT, "plugins", "dg");
const SKILLS_DIR = join(CODEX_PLUGIN_DIR, "skills");

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

describe("plugin manifests", () => {
	const claudePlugin = JSON.parse(
		readFileSync(join(REPO_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
	);
	const codexPlugin = JSON.parse(
		readFileSync(
			join(CODEX_PLUGIN_DIR, ".codex-plugin", "plugin.json"),
			"utf8",
		),
	);

	test("Claude Code points at the canonical skill tree", () => {
		expect(claudePlugin.skills).toEqual(["./plugins/dg/skills"]);
	});

	test("Codex points at the same skill tree from its plugin root", () => {
		expect(codexPlugin.skills).toBe("./skills/");
		expect(existsSync(SKILLS_DIR)).toBe(true);
	});

	test("Claude Code and Codex publish the same plugin version", () => {
		expect(claudePlugin.version).toBe(codexPlugin.version);
	});
});

describe("Codex marketplace", () => {
	const marketplace = JSON.parse(
		readFileSync(
			join(REPO_ROOT, ".agents", "plugins", "marketplace.json"),
			"utf8",
		),
	);

	test("publishes the dg plugin from the standard repo-local path", () => {
		const dg = marketplace.plugins.find(
			(plugin: { name: string }) => plugin.name === "dg",
		);
		expect(dg?.source).toEqual({
			source: "local",
			path: "./plugins/dg",
		});
		expect(dg?.policy).toEqual({
			installation: "AVAILABLE",
			authentication: "ON_INSTALL",
		});
		expect(dg?.category).toBe("Productivity");
		expect(existsSync(join(REPO_ROOT, dg.source.path))).toBe(true);
	});
});

describe("each shared skill directory", () => {
	test("there is at least one skill", () => {
		expect(skillDirs.length).toBeGreaterThan(0);
	});

	for (const name of skillDirs) {
		test(`${name}/ has a SKILL.md`, () => {
			expect(existsSync(join(SKILLS_DIR, name, "SKILL.md"))).toBe(true);
		});

		test(`${name}/ uses cross-host frontmatter`, () => {
			const skill = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
			expect(skill).not.toContain("argument-hint:");
			expect(skill).not.toContain("user-invocable:");
		});
	}
});

describe("no stale paths in the shared skill tree", () => {
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
		test(`${name}: bootstraps via the skills-cli bootstrap script`, () => {
			expect(md).toContain("skills-cli");
			expect(md).toContain("bootstrap.sh");
		});
		test(`${name}: can bootstrap without CLAUDE_PLUGIN_ROOT`, () => {
			expect(md).toContain(
				"https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh",
			);
			expect(md).not.toContain('SRC="${CLAUDE_PLUGIN_ROOT}/');
		});
		test(`${name}: does not run the TS source entrypoint`, () => {
			expect(md).not.toContain("src/index.ts");
		});
	}
});

describe("demo workflow parity", () => {
	const demo = readFileSync(join(SKILLS_DIR, "demo", "SKILL.md"), "utf8");

	test("new walkthroughs open in the extension editor", () => {
		expect(demo).toContain('"$DG" demo --edit /tmp/ai/demo/tour.md');
	});

	test("new videos open in the extension editor", () => {
		expect(demo).toContain('"$DG" demo --video --edit /tmp/ai/demo/tour.md');
	});

	test("the editor is required rather than host-discretionary", () => {
		expect(demo).toContain(
			"Always open a newly authored tour in the extension's",
		);
		expect(demo).toContain("Do not launch a new tour directly");
		expect(demo).toContain(
			"review and approve it in the extension, then play it",
		);
	});

	test("the extension editor is the only approval gate", () => {
		expect(demo).toContain(
			"The extension editor is the approval gate for both",
		);
		expect(demo).toContain("Do not present a chat approval table");
		expect(demo).not.toContain("Chat approval gate");
		expect(demo).not.toContain("After chat approval");
	});
});

describe("demo setup phase", () => {
	const demo = readFileSync(join(SKILLS_DIR, "demo", "SKILL.md"), "utf8");

	test("setup is optional and excluded from the demo by default", () => {
		expect(demo).toContain("## Phase 2 — Optional setup (off-demo by default)");
		expect(demo).toContain("Author reproducible preparation in `## Setup`");
		expect(demo).toContain("Keep `includeSetup: false` unless");
		expect(demo).toContain("the extension runs setup first as a durable");
	});

	test("explicitly included setup becomes leading tutorial steps", () => {
		expect(demo).toContain("With `includeSetup: true`");
		expect(demo).toContain("leading tutorial steps");
		expect(demo).toContain("included in narration, timing, progress, and");
	});

	test("setup protects authentication secrets", () => {
		expect(demo).toContain("credentials, MFA codes, CAPTCHA answers");
		expect(demo).toContain("Never put those values in a fill action");
	});
});
