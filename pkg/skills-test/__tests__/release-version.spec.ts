import { describe, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	bump,
	classify,
	detect,
	isReleaseCommit,
	prependChangelog,
	previousTag,
	renderNotes,
	stamp,
	stampTargets,
	type Commit,
	type DetectInput,
} from "../../../scripts/release-version";
import { REPO_ROOT, readRepoFile } from "./test-support";

const commit = (subject: string, body = ""): Commit => ({ subject, body });

describe("classify maps a commit to a semver bump", () => {
	test.each([
		["fix(cli): handle empty input", "patch"],
		["feat(inbox): sync filters", "minor"],
		["perf(thrash): cache diffs", "patch"],
		["refactor(cli): split module", "none"],
		["docs(readme): fix typo", "none"],
		["chore(deps): bump yaml", "none"],
		["ci(release): tweak job", "none"],
		["test(cli): add case", "none"],
		["style(cli): format", "none"],
		["feat(api)!: drop v1", "major"],
		["fix!: remove flag", "major"],
		["Merge branch 'master'", "none"],
		["update stuff", "none"],
	])("%s -> %s", (subject, level) => {
		expect<string>(classify(commit(subject))).toBe(level);
	});

	test("a BREAKING CHANGE footer in the body makes a major bump", () => {
		expect(
			classify(commit("fix(cli): rename flag", "Details.\n\nBREAKING CHANGE: --x is gone")),
		).toBe("major");
	});

	test("a BREAKING CHANGE mention mid-line does not count", () => {
		expect(classify(commit("fix(cli): x", "not a BREAKING CHANGE: footer"))).toBe(
			"patch",
		);
	});
});

describe("bump", () => {
	test.each([
		["patch", "1.21.2"],
		["minor", "1.22.0"],
		["major", "2.0.0"],
		["none", null],
	] as const)("1.21.1 + %s -> %s", (level, expected) => {
		expect(bump("1.21.1", level)).toBe(expected);
	});
});

describe("previousTag", () => {
	test("prefers v<base> over skills-v<base>", () => {
		expect(previousTag("1.21.1", ["skills-v1.21.1", "v1.21.1"])).toBe("v1.21.1");
	});

	test("falls back to skills-v<base>", () => {
		expect(previousTag("1.21.1", ["skills-v1.21.1", "v1.2.0"])).toBe(
			"skills-v1.21.1",
		);
	});

	test("never picks v1.2.0 for base 1.21.1", () => {
		expect(previousTag("1.21.1", ["v1.2.0", "v1.21.10"])).toBeNull();
	});
});

describe("isReleaseCommit", () => {
	test("matches only the release commit subject", () => {
		expect(isReleaseCommit("chore(release): cut 1.22.0")).toBe(true);
		expect(isReleaseCommit("chore(release): cut 1.22")).toBe(false);
		expect(isReleaseCommit("chore(release): cut 1.22.0 (#85)")).toBe(false);
		expect(isReleaseCommit("chore(spec): cut 1.22.0")).toBe(false);
	});
});

describe("renderNotes", () => {
	const commits = [
		commit("feat(inbox): sync Proton filters (#65)"),
		commit("fix(thrash): submit the kept review (#81)"),
		commit("perf(thrash): cache diffs (#90)"),
		commit("feat(api)!: drop v1 (#91)"),
		commit("docs(readme): typo (#92)"),
	];

	test("groups Breaking, Features, and Fixes in that order, with perf under Fixes", () => {
		const notes = renderNotes(commits);
		const breaking = notes.indexOf("### Breaking");
		const features = notes.indexOf("### Features");
		const fixes = notes.indexOf("### Fixes");
		expect(breaking).toBeGreaterThanOrEqual(0);
		expect(features).toBeGreaterThan(breaking);
		expect(fixes).toBeGreaterThan(features);
		expect(notes.indexOf("cache diffs")).toBeGreaterThan(fixes);
		expect(notes).not.toContain("typo");
	});

	test("links (#NN) to the pull request", () => {
		expect(renderNotes(commits)).toContain(
			"- feat(inbox): sync Proton filters ([#65](https://github.com/detailedghost/dg-ai/pull/65))",
		);
	});

	test("omits empty groups", () => {
		const notes = renderNotes([commit("fix(cli): x (#1)")]);
		expect(notes).toContain("### Fixes");
		expect(notes).not.toContain("### Features");
		expect(notes).not.toContain("### Breaking");
	});
});

describe("prependChangelog", () => {
	test("creates the file with a header when none exists", () => {
		expect(prependChangelog(null, "1.22.0", "2026-10-28", "### Fixes\n\n- a\n")).toBe(
			"# Changelog\n\n## v1.22.0 (2026-10-28)\n\n### Fixes\n\n- a\n",
		);
	});

	test("puts the new entry above older ones", () => {
		const first = prependChangelog(null, "1.22.0", "2026-10-28", "- a\n");
		const second = prependChangelog(first, "1.23.0", "2026-11-01", "- b\n");
		expect(second.indexOf("## v1.23.0")).toBeLessThan(second.indexOf("## v1.22.0"));
		expect(second.match(/^# Changelog/gm)).toHaveLength(1);
	});
});

describe("stampTargets and stamp", () => {
	test("lists the nine version files", () => {
		expect<string[]>([...stampTargets].sort()).toEqual(
			[
				".claude-plugin/plugin.json",
				"bun.lock",
				"pkg/dg-agent/package.json",
				"pkg/dg-agent/src/version.ts",
				"pkg/dg-daemon/package.json",
				"pkg/dg-daemon/src/server/status.ts",
				"pkg/extension/package.json",
				"pkg/skills-cli/package.json",
				"plugins/dg/.codex-plugin/plugin.json",
			].sort(),
		);
	});

	function stampedCopy(version: string): string {
		const dir = mkdtempSync(join(tmpdir(), "release-stamp-"));
		for (const target of stampTargets) {
			mkdirSync(dirname(join(dir, target)), { recursive: true });
			cpSync(join(REPO_ROOT, target), join(dir, target));
		}
		stamp(dir, version);
		return dir;
	}

	test("changes only version lines, including bun.lock workspaces", () => {
		const dir = stampedCopy("9.8.7");
		try {
			for (const target of stampTargets) {
				const before = readRepoFile(target).split("\n");
				const after = readFileSync(join(dir, target), "utf8").split("\n");
				expect(after).toHaveLength(before.length);
				const changed = after.filter((line, i) => line !== before[i]);
				expect(changed.length).toBeGreaterThan(0);
				for (const line of changed) expect(line).toContain("9.8.7");
			}
			const lock = readFileSync(join(dir, "bun.lock"), "utf8");
			const stamped = [
				...lock.matchAll(/"name": "(@dg\/[\w-]+)",\s+"version": "([^"]+)"/g),
			].filter((m) => m[2] === "9.8.7");
			expect(stamped.map((m) => m[1]).sort()).toEqual([
				"@dg/dg-agent",
				"@dg/dg-daemon",
				"@dg/extension",
				"@dg/skills-cli",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("keeps each stamped workspace version in bun.lock equal to its package.json", () => {
		const dir = stampedCopy("9.8.7");
		try {
			const lock = readFileSync(join(dir, "bun.lock"), "utf8");
			for (const [pkgPath, name] of [
				["pkg/extension", "@dg/extension"],
				["pkg/skills-cli", "@dg/skills-cli"],
				["pkg/dg-daemon", "@dg/dg-daemon"],
				["pkg/dg-agent", "@dg/dg-agent"],
			]) {
				const pkg = JSON.parse(
					readFileSync(join(dir, pkgPath!, "package.json"), "utf8"),
				);
				expect(lock).toContain(`"name": "${name}",\n      "version": "${pkg.version}"`);
			}
			expect(existsSync(join(dir, "node_modules"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("detect", () => {
	const base: DetectInput = {
		event: "push",
		bumpInput: "auto",
		base: "1.21.1",
		tags: ["skills-v1.21.1"],
		headSubject: "docs(readme): typo (#1)",
		commits: [commit("docs(readme): typo (#1)")],
	};

	test("skips when no commit is releasable", () => {
		expect(detect(base)).toEqual({
			mode: "skip",
			version: "1.21.1",
			previous_tag: "skills-v1.21.1",
		});
	});

	test("releases a minor bump for a feat in range", () => {
		const result = detect({
			...base,
			headSubject: "feat(x): y (#2)",
			commits: [commit("feat(x): y (#2)"), commit("fix(x): z (#3)")],
		});
		expect(result).toEqual({
			mode: "release",
			version: "1.22.0",
			previous_tag: "skills-v1.21.1",
		});
	});

	test("skips on push when head is the release commit", () => {
		const result = detect({
			...base,
			tags: ["v1.22.0", "v1.22.0"],
			base: "1.22.0",
			headSubject: "chore(release): cut 1.22.0",
		});
		expect(result.mode).toBe("skip");
	});

	test("republishes on dispatch when head is the release commit", () => {
		const result = detect({
			...base,
			event: "dispatch",
			tags: ["v1.22.0"],
			base: "1.22.0",
			headSubject: "chore(release): cut 1.22.0",
		});
		expect(result).toEqual({
			mode: "republish",
			version: "1.22.0",
			previous_tag: "v1.22.0",
		});
	});

	test("a dispatch bump override cuts a release with no releasable commits", () => {
		expect(detect({ ...base, event: "dispatch", bumpInput: "patch" })).toEqual({
			mode: "release",
			version: "1.21.2",
			previous_tag: "skills-v1.21.1",
		});
	});
});
