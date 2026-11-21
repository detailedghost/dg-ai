import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveRoute } from "../../dg/src/flat";
import { dgCommandForms, OWN_WORDS } from "./docs-help-kit";
import { REPO_ROOT } from "./test-support";

const PLUGINS_DIR = join(REPO_ROOT, "plugins");
const OLD_PROGRAM = /\bdg-(skills|agent|daemon)\b/;

function textFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		if (entry === "node_modules") return [];
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return textFiles(path);
		return /\.(md|sh|ps1|ts|js|mjs|json|ya?ml|txt)$/.test(entry) ? [path] : [];
	});
}

const FILES = textFiles(PLUGINS_DIR).map((path) => ({
	name: relative(REPO_ROOT, path),
	text: readFileSync(path, "utf8"),
}));

describe("plugin text uses the one flat dg program", () => {
	test("no file names dg-skills, dg-agent or dg-daemon", () => {
		const hits = FILES.flatMap(({ name, text }) =>
			text
				.split("\n")
				.flatMap((line, index) => (OLD_PROGRAM.test(line) ? [`${name}:${index + 1}: ${line.trim().slice(0, 90)}`] : [])),
		);
		expect(hits).toEqual([]);
	});

	test("every dg command in a code span or fence resolves to a route", () => {
		const bad = FILES.filter(({ name }) => name.endsWith(".md")).flatMap(({ name, text }) =>
			dgCommandForms(text)
				.filter(([word]) => word !== undefined && !OWN_WORDS.includes(word) && resolveRoute(word) === undefined)
				.map((words) => `${name}: dg ${words.join(" ")}`),
		);
		expect(bad).toEqual([]);
	});

	test("the guard knows the grouped and flat forms", () => {
		for (const word of ["agent", "daemon", "skills", "stash", "phone", "job", "upgrade"])
			expect([word, resolveRoute(word) !== undefined]).toEqual([word, true]);
		expect(resolveRoute("dg-skills")).toBeUndefined();
	});
});
