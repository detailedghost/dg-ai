import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const skillRoot = join(REPO_ROOT, "plugins/dg/skills/inbox-cleanup");

describe("inbox-cleanup skill distribution", () => {
	test("both plugin hosts discover inbox-cleanup through the canonical shared tree", () => {
		expect(existsSync(join(skillRoot, "SKILL.md"))).toBe(true);
		const claude = JSON.parse(readRepoFile(".claude-plugin", "plugin.json"));
		const codex = JSON.parse(
			readRepoFile("plugins/dg/.codex-plugin/plugin.json"),
		);
		expect(
			claude.skills.map((path: string) => resolve(REPO_ROOT, path)),
		).toContain(resolve(skillRoot, ".."));
		expect(resolve(REPO_ROOT, "plugins/dg", codex.skills)).toBe(
			resolve(skillRoot, ".."),
		);
	});

	test("uses the shipped CLI with local readable references for all providers and confirmation", () => {
		const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
		expect(skill.split("\n").length).toBeLessThanOrEqual(80);
		const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map(
			(match) => match[1],
		);
		expect(links.length).toBeGreaterThan(0);
		const content = [
			skill,
			...links.map((path) => readFileSync(join(skillRoot, path), "utf8")),
		].join("\n");
		expect(content).toContain(".dg/bin/dg-skills");
		for (const word of [
			"gmail",
			"outlook",
			"Proton",
			"--dry-run",
			"--confirm",
			"profile",
		])
			expect(content).toContain(word);
		expect(content).toMatch(/bootstrap\.sh/);
		for (const oldPath of [
			"~/code/email-organizer",
			"/home/detailedghost/code/email-organizer",
			"~/scripts",
			"bun run cli",
			"src/index.ts",
		])
			expect(content).not.toContain(oldPath);
	});

	test("declares inbox and supported agent client as runtime workspace dependencies", () => {
		const cli = JSON.parse(readRepoFile("pkg/skills-cli/package.json"));
		expect(cli.dependencies["@dg/inbox"]).toMatch(/^workspace:/);
		expect(cli.dependencies["@dg/dg-agent"]).toMatch(/^workspace:/);
		const agent = JSON.parse(readRepoFile("pkg/dg-agent/package.json"));
		expect(agent.exports["./client"]).toBeDefined();
		const inbox = JSON.parse(readRepoFile("pkg/inbox/package.json"));
		expect(Object.keys(inbox.dependencies ?? {})).not.toContain("playwright");
	});

	test("both skills workflows watch all compiled inbox runtime sources", () => {
		for (const name of ["skills-release.yml", "skills-blt.yml"]) {
			const workflow = readRepoFile(".github/workflows", name);
			for (const pkg of ["skills-cli", "inbox", "common", "dg-agent"])
				expect(workflow).toContain(`- pkg/${pkg}/**`);
		}
	});
});
