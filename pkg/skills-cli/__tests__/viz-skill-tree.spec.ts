import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SOURCE_SKILLS } from "./spec-fixtures";

const VIZ = join(SOURCE_SKILLS, "viz");
const REVIEW = join(SOURCE_SKILLS, "review");

function walk(dir: string): string[] {
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) files.push(...walk(path));
		else files.push(path);
	}
	return files;
}

function rel(root: string): string[] {
	return walk(root).map((path) => relative(root, path));
}

function textFiles(root: string): string[] {
	return walk(root).filter((path) => /\.(md|ts|astro|mjs|json)$/.test(path));
}

describe("vendored viz viewer allowlist", () => {
	const files = () => rel(VIZ);

	test("ships the viewer manifest, canonical lock, config and source", () => {
		for (const required of [
			"astro-viewer/package.json",
			"astro-viewer/bun.lock",
			"astro-viewer/astro.config.mjs",
			"astro-viewer/tsconfig.json",
			"astro-viewer/src/lib/respond-core.ts",
			"astro-viewer/src/sections/registry.ts",
			"astro-viewer/src/pages/index.astro",
		])
			expect(files()).toContain(required);
	});

	test("excludes dependencies, caches, private demo assets and binary work evidence", () => {
		for (const file of files()) {
			expect(file, file).not.toMatch(/(^|\/)node_modules\//);
			expect(file, file).not.toMatch(/(^|\/)\.(pw|astro|vite)\//);
			expect(file, file).not.toContain("public/demo-assets");
			expect(file, file).not.toMatch(/bun\.lockb$/);
			expect(file, file).not.toMatch(
				/\.(png|jpe?g|gif|webp|mp4|webm|mov|zip)$/i,
			);
		}
	});

	test("the only static public asset is the favicon", () => {
		const publicFiles = files().filter((file) =>
			file.startsWith("astro-viewer/public/"),
		);
		expect(publicFiles).toEqual(["astro-viewer/public/favicon.svg"]);
	});

	test("carries no work identifiers or machine-local paths", () => {
		for (const path of textFiles(VIZ)) {
			const text = readFileSync(path, "utf8");
			const name = relative(VIZ, path);
			expect(text, name).not.toMatch(/\/home\/[a-z][\w-]*\//);
			expect(text, name).not.toMatch(/frontfolio|vela_nav|\/Users\/[a-z]/i);
			expect(text, name).not.toContain("~/scripts");
		}
	});

	test("the lockfile pins every manifest dependency", () => {
		const manifest = JSON.parse(
			readFileSync(join(VIZ, "astro-viewer/package.json"), "utf8"),
		);
		const lock = readFileSync(join(VIZ, "astro-viewer/bun.lock"), "utf8");
		for (const name of Object.keys({
			...manifest.dependencies,
			...manifest.devDependencies,
		}))
			expect(lock, name).toContain(`"${name}"`);
	});
});

describe("viz skill document", () => {
	const skill = () => readFileSync(join(VIZ, "SKILL.md"), "utf8");

	test("has the viz name, no host-specific keys and the first-run bootstrap with literal-path calls", () => {
		const text = skill();
		expect(text).toMatch(/^name: viz$/m);
		expect(text).not.toMatch(/^(argument-hint|user-invocable):/m);
		expect(text).toMatch(
			/~\/\.dg\/bin\/dg-skills viz --help >\/dev\/null 2>&1 \|\|\n\s+curl/,
		);
		expect(text).toContain("~/.dg/bin/dg-skills viz");
	});

	test("the board prints its live-update command as the literal unquoted path", () => {
		const page = readFileSync(
			join(VIZ, "astro-viewer/src/pages/viz/[slug].astro"),
			"utf8",
		);
		expect(page).toContain("run: ~/.dg/bin/dg-skills viz phase ${slug}");
		expect(page).not.toMatch(/run: dg-skills/);
	});

	test("every reference it routes to ships with the skill", () => {
		const text = skill();
		const links = [
			...text.matchAll(
				/\]\((references\/[^)#]+)\)|`(references\/[\w.-]+\.md)`/g,
			),
		].map((match) => match[1] ?? match[2]);
		expect(links.length).toBeGreaterThan(0);
		for (const link of links)
			expect(existsSync(join(VIZ, link as string)), link).toBe(true);
	});

	test("documents the external Bun prerequisite and the VIZ_* isolation variables", () => {
		const all = textFiles(VIZ)
			.filter((path) => path.endsWith(".md"))
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");
		expect(all).toContain("Bun");
		for (const variable of ["VIZ_DIR", "VIZ_PORT", "VIZ_SKILL_DIR"])
			expect(all).toContain(variable);
	});

	test("no markdown or source emits a legacy viz-cli invocation or removed script path", () => {
		for (const path of [...textFiles(VIZ), ...textFiles(REVIEW)]) {
			if (path.endsWith(".test.ts")) continue;
			const text = readFileSync(path, "utf8");
			const name = relative(SOURCE_SKILLS, path);
			expect(text, name).not.toMatch(/(^|[\s`'"/])viz-cli(\s|`|$)/m);
			expect(text, name).not.toContain("scripts/bin");
			expect(text, name).not.toContain("~/.claude/skills");
		}
	});
});

describe("review skill", () => {
	test("ships SKILL.md and its four references with no host-specific frontmatter", () => {
		const text = readFileSync(join(REVIEW, "SKILL.md"), "utf8");
		expect(text).toMatch(/^name: review$/m);
		expect(text).not.toMatch(/^(argument-hint|user-invocable):/m);
		for (const name of ["board-ui", "details", "external", "local-mode"])
			expect(existsSync(join(REVIEW, "references", `${name}.md`)), name).toBe(
				true,
			);
	});

	test("drives the board through literal-path compiled viz calls", () => {
		const all = textFiles(REVIEW)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");
		expect(all).toContain("~/.dg/bin/dg-skills viz review");
		expect(all).toMatch(/~\/\.dg\/bin\/dg-skills viz (review-)?wait/);
	});

	test("links to the viz skill relatively", () => {
		const text = readFileSync(join(REVIEW, "SKILL.md"), "utf8");
		expect(text).toContain("../viz/");
	});
});
