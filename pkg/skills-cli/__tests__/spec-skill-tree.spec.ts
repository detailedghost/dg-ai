import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	SOURCE_SKILLS,
	SPEC_SKILLS_TREES,
	splitFrontmatter,
} from "./spec-fixtures";

const REQUIRED_VERBS = [
	"append-section",
	"context",
	"get",
	"lint-waves",
	"perms-batch",
	"prototype-ref",
	"roster",
	"scaffold",
	"set",
	"slice",
	"slugify",
];

const SCHEMA_FIELDS = [
	"feature",
	"feature_snake_case",
	"date",
	"version",
	"status",
	"current_slice",
	"slices",
	"permissions",
	"tools",
	"pr_strategy",
	"repos",
	"deploy_order",
	"worktree",
	"origin_repo",
	"parked_reason",
	"resume_after",
	"depends_on_specs",
	"predecessor",
	"predecessor_pr",
	"canonical_plan",
	"resolved_open_questions",
	"references",
	"bundle",
	"plan_path",
];

function files(skill: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else out.push(path);
		}
	};
	if (existsSync(join(SOURCE_SKILLS, skill))) walk(join(SOURCE_SKILLS, skill));
	return out;
}

const trees = SPEC_SKILLS_TREES.map((skill) => ({
	skill,
	files: files(skill).map((path) => ({
		path,
		name: relative(SOURCE_SKILLS, path),
		text: readFileSync(path, "utf8"),
	})),
}));

const callers = trees.filter(({ files }) =>
	files.some((file) => file.text.includes("~/.dg/bin/dg-skills")),
);

function skillMd(skill: string): string {
	return readFileSync(join(SOURCE_SKILLS, skill, "SKILL.md"), "utf8");
}

describe("migrated spec, sdlc, assign, grill-me, prd, kick and pickup skill trees", () => {
	test.each([...SPEC_SKILLS_TREES])(
		"%s has a SKILL.md named for its folder with no host-only keys",
		(skill) => {
			const { data } = splitFrontmatter(skillMd(skill)) as {
				data: Record<string, unknown>;
			};
			expect(data.name).toBe(skill);
			expect(typeof data.description).toBe("string");
			expect(data).not.toHaveProperty("argument-hint");
			expect(data).not.toHaveProperty("user-invocable");
		},
	);

	test.each(trees)(
		"$skill carries no retired command, private path or work identifier",
		({ files }) => {
			expect(files.length).toBeGreaterThan(0);
			const banned =
				/spec-cli|~\/scripts|~\/\.claude\/skills|\/home\/|worktree-cli|vcs-provider-cli|chain-cli|address-helper|thrash-helper|proxy-helper|file-cli|deps-upgrade-helper|meaningful-helper/;
			const hits = files
				.filter((file) => banned.test(file.text))
				.map((file) => file.name);
			expect(hits).toEqual([]);
		},
	);

	test.each(trees)(
		"$skill obsolete private permission-rule explanation is gone",
		({ files }) => {
			expect(files.length).toBeGreaterThan(0);
			const obsolete = /allow rule|Bash\(\/|tilde does not match/i;
			expect(
				files
					.filter((file) => obsolete.test(file.text))
					.map((file) => file.name),
			).toEqual([]);
		},
	);

	test("every dg-skills spec call uses the literal path and names a real subcommand", () => {
		const called = new Set<string>();
		for (const { files } of trees)
			for (const file of files) {
				expect(file.text).not.toMatch(/\$\{?DG\b/);
				for (const match of file.text.matchAll(
					/~\/\.dg\/bin\/dg-skills spec ([a-z][a-z-]*)/g,
				))
					called.add(match[1] ?? "");
			}
		for (const verb of REQUIRED_VERBS) expect(called.has(verb)).toBe(true);
		const known = new Set([
			...REQUIRED_VERBS,
			"perms",
			"next-nnn",
			"roundtable",
			"review",
			"brief",
			"diff-bundle",
			"audit",
			"ready",
			"pr-body",
			"issues",
			"resolve-path",
			"validate",
		]);
		expect([...called].filter((verb) => !known.has(verb))).toEqual([]);
	});

	test("the spec, assign, prd, kick and pickup skills all call the CLI", () => {
		expect(callers.map(({ skill }) => skill)).toEqual(
			expect.arrayContaining(["spec", "assign", "prd", "kick", "pickup"]),
		);
	});

	test.each(callers)(
		"$skill gates its first-run bootstrap on the installed CLI",
		({ skill }) => {
			expect(skillMd(skill)).toMatch(
				/~\/\.dg\/bin\/dg-skills \w[\w-]* --help >\/dev\/null 2>&1 \|\|\s+curl/,
			);
		},
	);

	test("every relative link resolves", () => {
		const missing: string[] = [];
		for (const { files } of trees)
			for (const file of files) {
				for (const match of file.text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
					const target = resolve(dirname(file.path), match[1] ?? "");
					if (!existsSync(target)) missing.push(`${file.name} -> ${match[1]}`);
				}
			}
		expect(missing).toEqual([]);
	});

	test("spec points at grill-me and sdlc relatively", () => {
		const text = trees
			.find((tree) => tree.skill === "spec")
			?.files.map((file) => file.text)
			.join("\n");
		for (const sibling of ["grill-me", "sdlc"])
			expect(text).toContain(`../${sibling}`);
	});

	test("grill-me points at the monolith template relatively", () => {
		const text = trees
			.find((tree) => tree.skill === "grill-me")
			?.files.map((file) => file.text)
			.join("\n");
		expect(text).toMatch(/\.\.\/(?:\.\.\/)?monolith\/references\/template\.md/);
	});

	test("sdlc vendors its PR body style guidance and finish links to it", () => {
		const style = join(SOURCE_SKILLS, "sdlc", "references", "pr-body-style.md");
		expect(existsSync(style)).toBe(true);
		expect(
			readFileSync(
				join(SOURCE_SKILLS, "sdlc", "references", "finish.md"),
				"utf8",
			),
		).toContain("pr-body-style.md");
	});

	test("sdlc keeps its slice-wave workflow template next to its references", () => {
		expect(
			existsSync(
				join(
					SOURCE_SKILLS,
					"sdlc",
					"references",
					"templates",
					"slice-wave.workflow.js",
				),
			),
		).toBe(true);
	});
});

describe("spec-schema vendored under the spec skill", () => {
	const schemaDir = join(SOURCE_SKILLS, "spec", "spec-schema");

	test("frontmatter-schema.yaml parses and defines every spec field", () => {
		const schema = Bun.YAML.parse(
			readFileSync(join(schemaDir, "frontmatter-schema.yaml"), "utf8"),
		) as { fields: Record<string, { type: unknown; mutability: string }> };
		expect(Object.keys(schema.fields).sort()).toEqual(
			[...SCHEMA_FIELDS].sort(),
		);
		for (const field of Object.values(schema.fields)) {
			expect(field.type).toBeDefined();
			expect(["immutable", "mutable", "append-only", "mixed"]).toContain(
				field.mutability,
			);
		}
	});

	test("both roundtable and spec-review templates ship with their agent sections", () => {
		const roundtable = readFileSync(
			join(schemaDir, "templates", "roundtable.md"),
			"utf8",
		);
		const review = readFileSync(
			join(schemaDir, "templates", "spec-review.md"),
			"utf8",
		);
		for (const heading of ["## Reviewer", "## QA-Perf", "## Security"]) {
			expect(roundtable).toContain(heading);
			expect(review).toContain(heading);
		}
		expect(roundtable).toContain("<plan_path>");
		expect(review).toContain("<spec_path>");
	});
});
