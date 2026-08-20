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
	const cliSkills = skillDirs.filter((name) =>
		readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8").includes(
			".dg/bin/dg-skills",
		),
	);

	test("at least one skill invokes the dg-skills binary", () => {
		expect(cliSkills.length).toBeGreaterThan(0);
	});

	for (const name of cliSkills) {
		const md = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");

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

describe("dg-server-invoking SKILL.md uses the compiled daemon binary", () => {
	const serverSkills = skillDirs.filter((name) =>
		readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8").includes(
			"dg-server",
		),
	);

	test("at least one skill exposes the dg-server harness", () => {
		expect(serverSkills.length).toBeGreaterThan(0);
	});

	for (const name of serverSkills) {
		const md = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");

		test(`${name}: invokes ~/.dg/bin/dg-server`, () => {
			expect(md).toContain(".dg/bin/dg-server");
		});

		test(`${name}: gates its bootstrap on the dg-server binary, not on dg-skills`, () => {
			const gates = md.match(/if\s*\[\s*!\s*-x\s*"([^"]+)"\s*\]/g) ?? [];
			expect(gates.length).toBeGreaterThan(0);
			const gated = gates.join("\n");
			expect(gated).toMatch(/DG_SERVER|dg-server/);
			expect(gated).not.toMatch(/^\s*if\s*\[\s*!\s*-x\s*"\$DG"\s*\]$/m);
		});

		test(`${name}: names the server-v release tag its binary ships under`, () => {
			expect(md).toMatch(/server-v/);
		});

		test(`${name}: documents the recv send status spawn stage close loop`, () => {
			for (const verb of [
				"recv",
				"send",
				"status",
				"spawn",
				"stage",
				"close",
			]) {
				expect(md).toMatch(new RegExp(`\\b${verb}\\b`));
			}
		});

		test(`${name}: documents the reserved timeout exit code`, () => {
			expect(md).toMatch(/exit\s+code/i);
			expect(md).toMatch(/timeout/i);
		});

		test(`${name}: does not run the TS source entrypoint`, () => {
			expect(md).not.toContain("src/index.ts");
		});
	}
});

// Rewritten post-611ca75: one CLI command opens both walkthrough and video;
// the browser's start screen, not a chat table, is the approval gate.
describe("demo workflow parity", () => {
	const demo = readFileSync(join(SKILLS_DIR, "demo", "SKILL.md"), "utf8");

	test("new walkthroughs open in the extension editor", () => {
		expect(demo).toContain('"$DG" demo --edit /tmp/ai/demo/tour.md');
	});

	test("mode (walkthrough vs video) is chosen in the browser, not a CLI flag", () => {
		expect(demo).toContain("no `--video` flag");
		expect(demo).toContain("the mode is chosen in the browser");
	});

	test("the editor is required rather than host-discretionary", () => {
		expect(demo).toContain("Your job is two steps");
		expect(demo).toContain("## Step 2");
		expect(demo).toContain("Open it in the extension");
		expect(demo).toContain("Confirm the browser reached it, then stop");
	});

	test("the extension editor is the only approval gate", () => {
		expect(demo).toContain("shows the **start screen**");
		expect(demo).toContain("which is the approval gate");
		expect(demo).not.toContain("Chat approval gate");
		expect(demo).not.toContain("After chat approval");
	});
});

describe("demo setup phase", () => {
	const demo = readFileSync(join(SKILLS_DIR, "demo", "SKILL.md"), "utf8");

	test("setup is optional and excluded from the demo by default", () => {
		expect(demo).toContain(
			"### Setup steps, when the tour needs prerequisite state",
		);
		expect(demo).toContain(
			"Use `## Setup` only for state the tutorial can't reach on its own",
		);
		expect(demo).toContain("Keep `includeSetup: false` (the default) unless");
		expect(demo).toContain(
			"**video narration and capture start only after that handoff**",
		);
		expect(demo).toContain("never contains the preparation.");
	});

	test("explicitly included setup becomes leading tutorial steps", () => {
		expect(demo).toContain("With `includeSetup: true`");
		expect(demo).toContain("leading tutorial steps");
	});

	test("setup protects authentication secrets", () => {
		// Whitespace-tolerant: the actual sentence wraps mid-phrase, and a prior
		// version of this test broke on that wrap alone, not a design change.
		expect(demo).toMatch(/credentials,\s+MFA codes,\s+and\s+CAPTCHA answers/);
		expect(demo).toMatch(/Never put\s+those values in a fill action\./);
	});
});

// Slice 6's verify loop; assertions target the contract (a real bound, a real
// escape hatch), not exact prose, since the rewrite's wording isn't fixed yet.
describe("demo verify-and-correct loop", () => {
	const demo = readFileSync(join(SKILLS_DIR, "demo", "SKILL.md"), "utf8");

	test("documents running demo --verify against the written plan before handing it off", () => {
		expect(demo).toContain("--verify");
	});

	test("bounds how many correction passes to attempt", () => {
		// A concrete numeral tied to pass/attempt/time — an unbounded "keep fixing
		// it" description must not satisfy this.
		expect(demo).toMatch(
			/\b\d+\b[^.\n]{0,40}\b(pass|passes|attempt|attempts|time|times)\b/i,
		);
	});

	test("tells the AI to stop and surface an uncorrectable finding, not loop forever or ship it broken", () => {
		const lower = demo.toLowerCase();
		expect(lower).toContain("cannot");
		expect(
			/surface|tell the user|ask the user|show the user|hand.{0,20}(back|off) to the user/.test(
				lower,
			),
		).toBe(true);
	});

	test("still chooses mode/narration/voice in the browser, not in chat", () => {
		expect(demo).toContain("Don't ask them in chat");
	});
});
