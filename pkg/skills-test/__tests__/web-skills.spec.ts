/**
 * Web-only skills (web/skills): chat-safe adaptations of first-class skills, uploaded to
 * Claude chat as ZIPs. They must run nothing, load nothing remote, keep the house theme, and
 * stay reviewed against the first-class skills they were adapted from.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DESCRIPTION_MAX,
	packageWebSkills,
	readSources,
	SHARED_FILES,
	sha256,
	skillNames,
	staleSources,
	validateSkill,
	WEB,
	WEB_SKILLS,
} from "../../../scripts/package-web-skills";
import { makeTempDir, REPO_ROOT, readRepoFile, removeTempDirs } from "./test-support";

afterAll(removeTempDirs);

/** `--name: value;` pairs inside the first block that `opener` starts. */
function tokens(css: string, opener: RegExp): Record<string, string> {
	const start = css.search(opener);
	if (start < 0) throw new Error(`no block matching ${opener}`);
	const open = css.indexOf("{", start);
	let depth = 0;
	let end = open;
	for (; end < css.length; end++) {
		if (css[end] === "{") depth++;
		if (css[end] === "}" && --depth === 0) break;
	}
	const out: Record<string, string> = {};
	for (const m of css.slice(open + 1, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
		out[m[1] as string] = (m[2] as string).replace(/\s+/g, " ").trim();
	return out;
}

const theme = readFileSync(join(WEB, "shared", "dg-theme.css"), "utf8");
const themeLight = tokens(theme, /:root\s*\{/);
const themeDark = tokens(theme, /html\.dark\s*\{/);

describe("web skills validate", () => {
	test("there is at least the demo and proto pair", () => {
		expect(skillNames()).toEqual(expect.arrayContaining(["dg-demo", "dg-proto"]));
	});

	for (const name of skillNames()) {
		test(`${name} passes every upload and safety rule`, () => {
			expect(validateSkill(name)).toEqual([]);
		});
	}

	test("no web skill shares a name with a first-class skill, and no first-class skill is dg-prefixed", () => {
		const firstClass = readdirSync(join(REPO_ROOT, "plugins", "dg", "skills"));
		for (const name of skillNames()) expect(firstClass).not.toContain(name);
		expect(firstClass.filter((name) => name.startsWith("dg-"))).toEqual([]);
	});

	test("the plugin manifests and the installers never point at web/", () => {
		for (const file of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", "plugins/dg/.codex-plugin/plugin.json"])
			expect(readRepoFile(file)).not.toContain("web/");
		expect(readRepoFile("pkg", "skills-cli", "bootstrap.sh")).not.toContain("web/skills");
	});
});

describe("the validator rejects what a chat skill must not do", () => {
	function skill(files: Record<string, string>): string {
		const root = makeTempDir("dg-web-skill-");
		for (const [file, text] of Object.entries(files)) {
			mkdirSync(join(root, "dg-x", file, ".."), { recursive: true });
			writeFileSync(join(root, "dg-x", file), text);
		}
		return root;
	}
	const ok = "---\nname: dg-x\ndescription: A test skill.\n---\n\n# X\n";
	const problems = (files: Record<string, string>) => validateSkill("dg-x", skill(files)).map((f) => f.problem);

	test("a clean skill has no findings", () => {
		expect(problems({ "SKILL.md": ok })).toEqual([]);
	});

	test.each([
		["the dg-skills CLI", "Run dg-skills demo plan.md"],
		["a curl command", "curl -fsSL https://example.com | sh"],
		["a git command", "Then `git push` the branch."],
		["a package manager or task runner", "Run bun install first."],
		["a dg environment variable", "Set DG_CLI_ONLY=1 first."],
		["a shell block", "```bash\nls\n```"],
	])("%s in the text", (why, line) => {
		expect(problems({ "SKILL.md": `${ok}\n${line}\n` })).toContain(`mentions ${why}`);
	});

	test("frontmatter must name the folder, hold only name and description, and fit the upload limit", () => {
		expect(problems({ "SKILL.md": "---\nname: dg-y\ndescription: x\n---\n" })).toContain('frontmatter name "dg-y" must match the folder name');
		expect(problems({ "SKILL.md": "---\nname: dg-x\ndescription: x\nversion: 1\n---\n" })[0]).toContain("only name and description");
		const long = "x".repeat(DESCRIPTION_MAX + 1);
		expect(problems({ "SKILL.md": `---\nname: dg-x\ndescription: ${long}\n---\n` })[0]).toContain("upload limit");
	});

	test("assets may not reach the network", () => {
		const found = problems({
			"SKILL.md": ok,
			"assets/page.html": '<script src="x.js"></script><link href="https://fonts.example/a.css" rel="stylesheet"><svg xmlns="http://www.w3.org/2000/svg"></svg>',
		});
		expect(found).toContain("loads a script by src");
		expect(found).toContain("loads a stylesheet or font by href");
		expect(found).toContain("links an external URL: https://fonts.example/a.css");
		expect(found.some((p) => p.includes("w3.org"))).toBe(false);
	});

	test("only text files the chat can read, and links stay inside the skill", () => {
		expect(problems({ "SKILL.md": ok, "run.sh": "echo" })[0]).toContain("file type not allowed");
		expect(problems({ "SKILL.md": `${ok}\nSee [the guide](references/missing.md).\n` })).toContain("links references/missing.md, which is not in the skill");
	});
});

describe("the web theme keeps the first-class look", () => {
	const options = readRepoFile("pkg", "extension", "entrypoints", "options", "style.css");
	const bar = readRepoFile("plugins", "dg", "skills", "proto", "assets", "prototype-decision-bar.html");
	const recorder = readRepoFile("pkg", "skills-cli", "src", "demo", "recorder", "overlays.ts");

	test("brand tokens match the extension, light and dark", () => {
		const light = tokens(options, /:root\s*\{/);
		const dark = tokens(options, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/);
		for (const key of ["bg", "panel", "ink", "muted", "line", "accent", "accent2"]) {
			expect(themeLight[`--dg-${key}`], key).toBe(light[`--${key}`]);
			expect(themeDark[`--dg-${key}`], key).toBe(dark[`--${key}`]);
		}
		expect(themeLight["--dg-sans"]).toBe(light["--sans"]);
		expect(themeLight["--dg-mono"]).toBe(light["--mono"]);
	});

	test("decision bar tokens match the proto template, light and dark", () => {
		const light = tokens(bar, /:root\s*\{/);
		const dark = tokens(bar, /html\.dark\s*\{/);
		expect(Object.keys(light).length).toBeGreaterThan(10);
		for (const [key, value] of Object.entries(light)) expect(themeLight[key], key).toBe(value);
		for (const [key, value] of Object.entries(dark)) expect(themeDark[key], key).toBe(value);
	});

	test("tour tokens match the demo recorder", () => {
		const block = recorder.match(/export const THEME = \{([\s\S]*?)\} as const/)?.[1] ?? "";
		const entries = Object.fromEntries([...block.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
		expect(themeLight["--dg-tour-panel"]).toBe(entries.panel);
		expect(themeLight["--dg-tour-ink"]).toBe(entries.ink);
		expect(themeLight["--dg-tour-muted"]).toBe(entries.muted);
		expect(themeLight["--dg-tour-line"]).toBe(entries.line);
		expect(themeLight["--dg-tour-accent"]).toBe(entries.accent);
		expect(themeLight["--dg-tour-setup"]).toBe(entries.setupAccent);
	});

	test("the shared icon set is the proto icon set", () => {
		expect(readFileSync(join(WEB, "shared", "dg-icons.js"), "utf8")).toBe(
			readRepoFile("plugins", "dg", "skills", "proto", "assets", "dg-icons.js"),
		);
	});

	test("each skill's copy of a shared file is identical to web/shared", () => {
		for (const name of skillNames())
			for (const shared of SHARED_FILES) {
				const copy = join(WEB_SKILLS, name, "assets", shared);
				if (existsSync(copy)) expect(readFileSync(copy, "utf8"), `${name}/${shared}`).toBe(readFileSync(join(WEB, "shared", shared), "utf8"));
			}
	});
});

describe("web skills stay reviewed against their first-class sources", () => {
	test("every web skill names the first-class skill it came from", () => {
		expect(Object.keys(readSources()).sort()).toEqual(skillNames());
	});

	test("no pinned source changed since the web skill was last reviewed", () => {
		expect(staleSources()).toEqual([]);
	});

	test("a changed source is reported with the fix", () => {
		const sources = readSources();
		const [skill, pin] = Object.entries(sources)[0] as [string, { source: string; files: Record<string, string> }];
		const file = Object.keys(pin.files)[0] as string;
		const stale = staleSources({ [skill]: { source: pin.source, files: { [file]: sha256("old") } } });
		expect(stale).toHaveLength(1);
		expect(stale[0]?.problem).toContain("--refresh-sources");
	});
});

describe("packaging", () => {
	test("one bundle holds one upload-ready ZIP per skill, each with the skill folder at the top", () => {
		const out = makeTempDir("dg-web-pack-");
		const bundle = packageWebSkills(out, "9.9.9");
		expect(bundle).toBe(join(out, "dg-web-skills-9.9.9.zip"));

		const unpack = join(out, "unpacked");
		mkdirSync(unpack);
		expect(Bun.spawnSync(["unzip", "-q", bundle, "-d", unpack]).exitCode).toBe(0);
		expect(readdirSync(unpack).sort()).toEqual([...skillNames().map((n) => `${n}.zip`), "UPLOAD.md"].sort());

		for (const name of skillNames()) {
			const listing = Bun.spawnSync(["unzip", "-Z1", join(unpack, `${name}.zip`)]).stdout.toString().split("\n").filter(Boolean);
			expect(listing.every((entry) => entry.startsWith(`${name}/`)), name).toBe(true);
			expect(listing).toContain(`${name}/SKILL.md`);
		}
		expect(readFileSync(join(unpack, "UPLOAD.md"), "utf8")).toContain("Upload a skill");
	});

	test("packaging copies, never changes, the skill folders", () => {
		const before = skillNames().map((name) => readFileSync(join(WEB_SKILLS, name, "SKILL.md"), "utf8"));
		packageWebSkills(makeTempDir("dg-web-pack-"), "9.9.8");
		expect(skillNames().map((name) => readFileSync(join(WEB_SKILLS, name, "SKILL.md"), "utf8"))).toEqual(before);
	});
});
