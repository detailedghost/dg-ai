import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const repo = join(import.meta.dir, "../../..");

function filesUnder(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === "node_modules" || entry.name === ".git") return [];
		const path = join(root, entry.name);
		return entry.isDirectory()
			? filesUnder(path)
			: entry.isFile()
				? [path]
				: [];
	});
}

const skillFiles = filesUnder(join(repo, "plugins/dg/skills"));
const publicFiles = [
	...skillFiles,
	...filesUnder(join(repo, "pkg/skills-cli/src")),
];

function matches(files: string[], pattern: RegExp): string[] {
	return files.flatMap((file) =>
		readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line, index) =>
				pattern.test(line) ? [`${relative(repo, file)}:${index + 1}`] : [],
			),
	);
}

function legacyInvocation(commands: string[]): RegExp {
	const names = commands.join("|");
	return new RegExp(
		[
			"(?:^\\s*|\\$\\(\\s*|`)(?:" + names + ")(?:\\.ts)?(?=\\s|`|$)",
			"[\"'](?:" + names + ")\\s+",
			"\\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|run(?:Capture|Shell)?)\\s*\\(\\s*(?:\\[\\s*)?[\"'`](?:" +
				names +
				")(?:\\.ts)?(?=[\"'`\\s])",
		].join("|"),
	);
}

const retiredHelpers = legacyInvocation([
	"stash",
	"stash-cli",
	"clipboard-image",
	"vcs-provider-cli",
	"proxy-helper",
	"bg-helper",
]);
const consumerFiles = skillFiles.filter((file) =>
	[
		"what-changed",
		"clipboard-img",
		"hook-comment-disable",
		"wayfinder",
		"refactor",
	].some((name) =>
		file.startsWith(join(repo, "plugins/dg/skills", name) + sep),
	),
);

describe("public skill distribution", () => {
	test("contains no private machine paths or work configuration", () => {
		expect(publicFiles.length).toBeGreaterThan(0);
		expect(
			matches(
				publicFiles,
				/jasperridge|JRDEV|dburgos|\/home\/detailedghost|clockify-sync|~\/scripts\//i,
			),
		).toEqual([]);
	});

	test("does not invoke removed helpers in code or skill references", () => {
		expect(matches(publicFiles, retiredHelpers)).toEqual([]);
	});

	test("the migrated consumer trees require no legacy spec executable", () => {
		expect(consumerFiles.length).toBeGreaterThan(0);
		expect(matches(consumerFiles, legacyInvocation(["spec-cli"]))).toEqual([]);
	});

	test("contains no legacy scripts-root dependencies", () => {
		expect(matches(publicFiles, /\bscriptsRoot\b|\bSCRIPTS_ROOT\b/)).toEqual(
			[],
		);
	});
});

describe("legacy executable detection", () => {
	test.each([
		"stash -G viz",
		"  stash tool",
		"Use `stash tool` for a path.",
		"$(stash -s tool)",
		"clipboard-image photo.png",
		"Use `clipboard-image -`.",
		"$(clipboard-image -s)",
		"vcs-provider-cli detect",
		"proxy-helper codex --prompt-file task.md",
		"bg-helper run command",
		'Bun.spawn(["proxy-helper", "codex"])',
		'Bun.spawn(["stash", "tool"])',
		'runCapture("clipboard-image", ["-"])',
		'const command = "stash -G viz";',
	])("rejects a bare helper invocation in %s", (line) => {
		expect(retiredHelpers.test(line)).toBe(true);
	});

	test.each([
		'"$DG" stash -G viz',
		'$("$DG" stash -s tool)',
		'"$DG" clipboard-image photo.png',
		'"$DG" vcs-provider detect',
		'"$DG" proxy codex --prompt-file task.md',
		'"$DG" proxy background run command',
		"const legacyName = /^proxy-helper(?:\\.sh)?$/;",
		'Bun.spawn([binary, "stash", "tool"])',
		'const name = "clipboard-image";',
		"git stash pop",
	])("allows a compiled invocation or command label in %s", (line) => {
		expect(retiredHelpers.test(line)).toBe(false);
	});
});
