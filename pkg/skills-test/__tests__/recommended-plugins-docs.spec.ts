import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { importedPlugins, readMarketplace } from "./marketplace-support";
import { REPO_ROOT, readRepoFile } from "./test-support";

const INSTALL_FLAG = "dg-skills install --with-recommended";
const ADR_PATH = join("docs", "adr", "0027-optional-third-party-plugins.md");
const RETIRED = ["teach", "wait-what"] as const;

const dgSkillNames = () =>
	readdirSync(join(REPO_ROOT, "plugins", "dg", "skills"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);

const flat = (text: string) => text.replace(/\s+/g, " ");
const installDoc = () => flat(readRepoFile("docs", "install.md"));
const recommendedSection = () => {
	const text = readRepoFile("docs", "install.md");
	const start = text.indexOf("## Recommended plugins");
	if (start < 0) return "";
	const rest = text.slice(start + 1);
	const next = rest.search(/\n## /);
	return flat(next < 0 ? rest : rest.slice(0, next));
};

describe("docs/install.md Recommended plugins section", () => {
	test("has a Recommended plugins heading", () => {
		expect(readRepoFile("docs", "install.md")).toContain("## Recommended plugins");
	});

	test("names the install flag and every marketplace imported plugin", () => {
		const section = recommendedSection();
		expect(section).toContain(INSTALL_FLAG);
		for (const plugin of importedPlugins(readMarketplace()))
			expect(section).toContain(`\`${plugin.name}\``);
	});

	test("explains pin, bump, Codex and OpenCode path, collisions and offline behavior", () => {
		const section = recommendedSection().toLowerCase();
		expect(section).toContain("bump-plugin-pin");
		expect(section).toContain("pinned");
		expect(section).toContain("--skills-only");
		expect(section).toContain("codex");
		expect(section).toContain("opencode");
		const collisions = dgSkillNames().filter((n) => ["grill-me", "wayfinder"].includes(n));
		expect(collisions.sort()).toEqual(["grill-me", "wayfinder"]);
		for (const name of collisions) expect(section).toContain(name);
		expect(section).toMatch(/no network|offline/);
	});

	test("lists the private copies of unslop to delete", () => {
		const section = recommendedSection();
		expect(section).toMatch(/delete|remove/i);
		expect(section).toContain("~/.claude/skills/unslop");
	});

	test("lists the Codex and OpenCode private copies of unslop too", () => {
		const section = recommendedSection();
		for (const path of ["~/.agents/skills/unslop", "~/.config/opencode/skills/unslop"])
			expect(section).toContain(path);
	});

	test("a reader searching for unslop finds the install flag and the delete list", () => {
		const doc = installDoc();
		expect(doc).toContain("unslop");
		expect(doc).toContain(INSTALL_FLAG);
		expect(doc).toMatch(/delete|remove/i);
	});

	test("says /teach and /wait-what come from mattpocock-skills", () => {
		const doc = installDoc();
		for (const name of RETIRED) expect(doc).toContain(`/${name}`);
		expect(doc).toContain("mattpocock-skills");
		expect(doc).toContain("--with-recommended");
	});

	test("README links to the Recommended plugins anchor", () => {
		expect(readRepoFile("README.md")).toContain("docs/install.md#recommended-plugins");
	});
});

describe("polish pr.md unslop install hint", () => {
	const pr = () => flat(readRepoFile("plugins", "dg", "skills", "polish", "references", "pr.md"));

	test("points at the --with-recommended install", () => {
		expect(pr()).toContain(INSTALL_FLAG);
	});

	test("drops the stale unslop plugin install hint", () => {
		expect(pr()).not.toContain("/plugin install unslop");
	});

	test("keeps the optional guard sentence", () => {
		expect(pr()).toMatch(/\/unslop:unslop[^\n]*is not installed, skip/i);
	});
});

describe("ADR 0027 optional third-party plugins", () => {
	test("exists with the numbered title and a Status line", () => {
		expect(existsSync(join(REPO_ROOT, ADR_PATH))).toBe(true);
		const adr = readRepoFile(ADR_PATH);
		expect(adr).toMatch(/^# 0027 — /m);
		expect(adr).toMatch(/^Status: (Proposed|Accepted)/m);
	});

	test("follows the template sections", () => {
		const adr = readRepoFile(ADR_PATH);
		for (const heading of ["Context", "Decision", "Consequences", "Alternatives considered", "References"])
			expect(adr).toContain(`## ${heading}`);
	});

	test("is linked from the ADR table of contents", () => {
		expect(readRepoFile("docs", "adr", "toc.md")).toContain("(0027-optional-third-party-plugins.md)");
	});
});

describe("skill indexes after teach and wait-what retire", () => {
	for (const parts of [["README.md"], ["plugins", "dg", "skills", "README.md"]])
		test(`${parts.join("/")} has no teach or wait-what row`, () => {
			const doc = readRepoFile(...parts);
			for (const name of RETIRED) {
				expect(doc).not.toContain(`\`${name}\``);
				expect(doc).not.toContain(`\`${name}/\``);
				expect(doc).not.toMatch(new RegExp(`^\\|\\s*\\[?${name}\\b`, "m"));
			}
		});
});
