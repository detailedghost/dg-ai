import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { makeTempDir } from "./git-repo-fixtures";
import { mergeEnv } from "./module-call";
import { SOURCE_SKILLS } from "./spec-fixtures";

const SKILL = join(SOURCE_SKILLS, "viz");

const REQUIRED_SUITES = [
	"astro-viewer/src/sections/xss-json-island-escaping.test.ts",
	"astro-viewer/src/sections/ReviewSection.verdict-result.test.ts",
	"astro-viewer/src/sections/ReviewSection.viewed-comments-sort.test.ts",
	"astro-viewer/src/sections/ReviewSection.range-comment.test.ts",
	"astro-viewer/src/sections/ReviewSection.marked-resilience.test.ts",
	"astro-viewer/src/sections/registry.test.ts",
	"astro-viewer/src/lib/respond-core.test.ts",
	"astro-viewer/src/lib/review-syntax.test.ts",
	"astro-viewer/src/lib/review-file-tree.test.ts",
	"references/payload-schema-erd.test.ts",
];

function listSuites(dir: string): string[] {
	const found: string[] = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules") continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) found.push(...listSuites(path));
		else if (name.endsWith(".test.ts")) found.push(relative(SKILL, path));
	}
	return found.sort();
}

async function runSuites(files: string[]) {
	const home = makeTempDir("dg-viz-suites-");
	const proc = Bun.spawn(
		[process.execPath, "test", ...files.map((file) => `./${file}`)],
		{
			cwd: SKILL,
			env: mergeEnv({ HOME: home, NO_COLOR: "1" }),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	rmSync(home, { recursive: true, force: true });
	return { output: `${stdout}\n${stderr}`, exitCode };
}

describe("vendored viz viewer suites", () => {
	const suites = () => listSuites(SKILL);

	test("the security, review, all_clear and result suites are vendored", () => {
		for (const required of REQUIRED_SUITES)
			expect(suites()).toContain(required);
	});

	test("no vendored suite reads the user's home or a legacy skill location", () => {
		for (const file of suites()) {
			const source = readFileSync(join(SKILL, file), "utf8");
			expect(source, file).not.toMatch(
				/homedir\(\)|\.claude\/skills|scripts\/ai\/skills/,
			);
		}
	});

	test("the viewer's own bun test run passes with an empty HOME", async () => {
		const { output, exitCode } = await runSuites(suites());
		expect(output).not.toMatch(/\b0 pass\b/);
		expect(output).toMatch(/\b[1-9]\d* pass\b/);
		expect(output).toMatch(/\b0 fail\b/);
		expect(exitCode).toBe(0);
	}, 180_000);

	test("the payload schema doc test reads the skill's own references", async () => {
		const erd = suites().find((file) =>
			file.endsWith("payload-schema-erd.test.ts"),
		);
		expect(erd).toBeDefined();
		expect(readFileSync(join(SKILL, erd as string), "utf8")).toContain(
			"payload-schema.md",
		);
	});
});
