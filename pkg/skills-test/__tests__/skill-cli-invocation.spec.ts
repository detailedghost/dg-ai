import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./test-support";

const SKILLS_DIR = join(REPO_ROOT, "plugins", "dg", "skills");

function markdownFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		if (entry === "node_modules") return [];
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return markdownFiles(path);
		return entry.endsWith(".md") ? [path] : [];
	});
}

const FILES = markdownFiles(SKILLS_DIR).map((path) => ({
	name: relative(SKILLS_DIR, path),
	text: readFileSync(path, "utf8"),
}));

const PACKAGED = readdirSync(SKILLS_DIR)
	.filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
	.sort((a, b) => b.length - a.length);

const BARE_COMMAND = new RegExp(
	`(?<![\\w./~:$<>-])/(${PACKAGED.join("|")})(?![\\w:/-]|\\.\\w)`,
);

function offenders(test: (text: string) => string | undefined): string[] {
	return FILES.flatMap(({ name, text }) => {
		const hit = test(text);
		return hit ? [`${name}: ${hit}`] : [];
	});
}

describe("packaged skills call the CLI by its literal path", () => {
	test("no skill document resolves the binary through a $DG variable", () => {
		expect(
			offenders(
				(text) =>
					text.match(/"?\$\{?DG(?:_AGENT|_SKILLS)?\}?"?(?=[\s)`'"]|$)/m)?.[0],
			),
		).toEqual([]);
	});

	test("no bootstrap block branches on CLAUDE_PLUGIN_ROOT", () => {
		expect(
			offenders((text) => {
				const fences = text.match(/```[\s\S]*?```/g) ?? [];
				const block = fences.find((fence) =>
					/LOCAL_BOOTSTRAP|PLUGIN_ROOT/.test(fence),
				);
				const line = text
					.split("\n")
					.find((l) => /bootstrap/i.test(l) && /PLUGIN_ROOT/.test(l));
				return block?.split("\n")[1] ?? line;
			}),
		).toEqual([]);
	});

	test("every bootstrap block gates on the installed binary and passes --cli-only unless the skill needs dg-agent or the extension", () => {
		const needsFullInstall = [
			"browser",
			"chat",
			"demo",
			"inbox-cleanup",
			"overwatch",
			"phone-friend",
			"proto",
			"pushup",
		];
		const bad = FILES.filter(
			({ name, text }) =>
				name.endsWith("SKILL.md") && /bootstrap\.sh \| sh/.test(text),
		).filter(({ name, text }) => {
			const skill = name.split("/")[0] ?? "";
			const cliOnly = /bootstrap\.sh \| sh -s -- --cli-only/.test(text);
			return needsFullInstall.includes(skill) ? cliOnly : !cliOnly;
		});
		expect(bad.map(({ name }) => name)).toEqual([]);
	});
});

describe("packaged skills name each other with the dg: prefix", () => {
	test("no document prints a bare /<packaged-skill> command", () => {
		expect(
			offenders((text) => {
				const hit = text
					.split("\n")
					.find((line) => BARE_COMMAND.test(line.replace(/\]\([^)]*\)/g, "")));
				return hit?.trim().slice(0, 100);
			}),
		).toEqual([]);
	});
});
