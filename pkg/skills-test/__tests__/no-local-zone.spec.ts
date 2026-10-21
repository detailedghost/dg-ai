import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

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
	...filesUnder(join(repo, "pkg/channel-review/src")),
];

const LOCAL_TERMS_FILE = ".no-local-zone.local";

function localTerms(): RegExp | null {
	const file = join(repo, LOCAL_TERMS_FILE);
	if (!existsSync(file)) return null;
	const terms = readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"))
		.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return terms.length > 0 ? new RegExp(terms.join("|"), "i") : null;
}

const EMAIL_PART =
	"\\b[\\w.+-]+@(?!example\\.|users\\.noreply\\.github\\.com|anthropic\\.com|thread\\.v2)[\\w-]+(?:\\.[\\w-]+)+\\b";

const NON_EMAIL_PARTS = [
	"/home/(?!user\\b|runner\\b|<)[a-z_][a-z0-9_-]*/",
	"/Users/(?!user\\b|runner\\b|<)[A-Za-z_][\\w.-]*/",
	"[A-Za-z]:\\\\Users\\\\(?!user\\b|<)[\\w.-]+",
	"~/scripts/",
	"(?:~|\\$HOME|\\$\\{HOME\\}|\\$\\{homedir\\(\\)\\}|\\$\\{os\\.homedir\\(\\)\\})/\\.claude/skills/",
	"\\b(?:ghp|gho|ghs|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{16,}",
	"\\bAKIA[0-9A-Z]{16}\\b",
	"\\bsk-[A-Za-z0-9]{20,}",
];

const PRIVATE_PATTERN = new RegExp(
	[...NON_EMAIL_PARTS, EMAIL_PART].join("|"),
	"i",
);
const LOCKFILE_PATTERN = new RegExp(NON_EMAIL_PARTS.join("|"), "i");

function matches(files: string[], pattern: RegExp): string[] {
	return files.flatMap((file) => {
		const filePattern =
			pattern === PRIVATE_PATTERN && basename(file) === "bun.lock"
				? LOCKFILE_PATTERN
				: pattern;
		return readFileSync(file, "utf8")
			.split("\n")
			.flatMap((line, index) =>
				filePattern.test(line) ? [`${relative(repo, file)}:${index + 1}`] : [],
			);
	});
}

function legacyInvocation(commands: string[]): RegExp {
	const names = commands.join("|");
	return new RegExp(
		[
			"(?:^\\s*|\\$\\(\\s*|`)(?:(?:bash|sh)\\s+)?(?:" +
				names +
				")(?:\\.ts|\\.sh)?(?=\\s|`|$)",
			"[\"'](?:(?:bash|sh)\\s+)?(?:" + names + ")(?:\\.ts|\\.sh)?\\s+",
			"\\b(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?|run(?:Capture|Shell)?)\\s*\\(\\s*(?:\\[\\s*)?(?:[\"'`](?:bash|sh)[\"'`]\\s*,\\s*)?[\"'`](?:" +
				names +
				")(?:\\.ts|\\.sh)?(?=[\"'`\\s])",
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
	"address-helper",
	"thrash-helper",
	"chain",
	"chain-cli",
	"file-cli",
	"meaningful-helper",
	"deps-upgrade-helper",
	"catchup",
	"verify-build",
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
			matches(publicFiles, PRIVATE_PATTERN),
		).toEqual([]);
	});

	test("includes the channel-review sources in the scanned files", () => {
		const scanned = publicFiles.map((file) => relative(repo, file));
		expect(scanned).toContain("pkg/channel-review/src/config.ts");
	});

	test("contains none of the terms in the optional local list", () => {
		const terms = localTerms();
		if (terms) expect(matches(publicFiles, terms)).toEqual([]);
	});

	test.each([
		"/home/alice/project",
		"/Users/alice/Documents",
		"C:\\Users\\alice\\file",
		"~/scripts/ai/run.ts",
		"Read(~/.claude/skills/thrash/**)",
		"see ~/.claude/skills/grill-me/SKILL.md",
		"${homedir()}/.claude/skills/thrash",
		"$HOME/.claude/skills/x",
		"${HOME}/.claude/skills/x",
		"alice@corp.test",
		"ghp_abcdefghijklmnopqrstuvwxyz0123",
		"AKIAABCDEFGHIJKLMNOP",
	])("flags %s as private", (line) => {
		expect(PRIVATE_PATTERN.test(line)).toBe(true);
	});

	test.each([
		"/home/user/project",
		"/mnt/c/Users/<user>/Downloads",
		"noreply@anthropic.com",
		"someone@example.com",
		"../grill-me/SKILL.md",
		"plugins/dg/skills/thrash/SKILL.md",
	])("allows %s", (line) => {
		expect(PRIVATE_PATTERN.test(line)).toBe(false);
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
		"address-helper gather-unresolved",
		"thrash-helper compile . --diff review.diff",
		"chain plan 1 2",
		"chain-cli render 1 2",
		"file-cli list --group-by-label",
		"meaningful-helper info",
		"deps-upgrade-helper prepare",
		"catchup.sh --no-push",
		"bash catchup.sh --no-push",
		'Bun.spawn(["bash", "catchup.sh"])',
		"verify-build.sh",
		'runCapture("address-helper", ["probe"])',
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
		'"$DG" address gather-unresolved',
		'"$DG" thrash compile . --diff review.diff',
		'"$DG" chain plan 1 2',
		'"$DG" file list --group-by-label',
		'"$DG" meaningful info',
		'"$DG" deps-upgrade prepare',
		'"$DG" catchup --no-push',
		"const legacyName = /^proxy-helper(?:\\.sh)?$/;",
		'Bun.spawn([binary, "stash", "tool"])',
		'const name = "clipboard-image";',
		"git stash pop",
	])("allows a compiled invocation or command label in %s", (line) => {
		expect(retiredHelpers.test(line)).toBe(false);
	});
});
