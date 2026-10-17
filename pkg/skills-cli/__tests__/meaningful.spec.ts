/** Real-git contracts for meaningful; all remotes, HOME and durable state are disposable. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isolateCliTests, runGit } from "./cli-fixtures";
import { makeTempDir, scratchFixtures } from "./git-repo-fixtures";
import { writeFakeCli } from "./fake-cli";
import { stateDir } from "../../common/src/node/scratch-paths";

const BUN_BIN = process.execPath;
const CLI = join(import.meta.dir, "../src/index.ts");
const fixtures = scratchFixtures();
isolateCliTests();
afterEach(() => fixtures.cleanup());

interface Repo {
	dir: string;
	bare: string;
	base: string;
}
interface JsonGroup {
	subject: string;
	body?: string;
	author?: string;
	coauthors?: string[];
	files: string[];
}

function git(repo: Repo, args: string[]): string {
	return runGit(args, repo.dir).trimEnd();
}

function write(repo: Repo, name: string, content: string): void {
	const file = join(repo.dir, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

function makeRepo(
	seed: Record<string, string> = { "README.md": "root\n" },
	tracked = true,
	directory?: string,
): Repo {
	const dir = directory ?? fixtures.tmp("dg-meaningful-repo-");
	mkdirSync(dir, { recursive: true });
	const bare = fixtures.tmp("dg-meaningful-origin-");
	fixtures.git(["init", "--bare", "-q", "-b", "main"], bare);
	fixtures.git(["init", "-q", "-b", "main"], dir);
	const repo = { dir, bare, base: "" };
	git(repo, ["config", "user.name", "Test"]);
	git(repo, ["config", "user.email", "test@example.invalid"]);
	git(repo, ["config", "commit.gpgsign", "false"]);
	git(repo, ["remote", "add", "origin", bare]);
	for (const [name, content] of Object.entries(seed))
		write(repo, name, content);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "-m", "chore: initial"]);
	git(repo, ["push", "-u", "origin", "main"]);
	git(repo, [
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/main",
	]);
	git(repo, ["tag", "base"]);
	repo.base = git(repo, ["rev-parse", "base"]);
	git(repo, ["checkout", "-q", "-b", "feature/meaningful"]);
	if (tracked) git(repo, ["push", "-u", "origin", "HEAD"]);
	return repo;
}

function commit(
	repo: Repo,
	files: Record<string, string>,
	subject = "wip: everything",
	author?: string,
): string {
	for (const [name, content] of Object.entries(files))
		write(repo, name, content);
	git(repo, ["add", "-A"]);
	git(repo, [
		"commit",
		"-q",
		"-m",
		subject,
		...(author ? ["--author", author] : []),
	]);
	return git(repo, ["rev-parse", "HEAD"]);
}

function runMeaningful(repo: Pick<Repo, "dir">, args: readonly string[]) {
	const proc = Bun.spawnSync([BUN_BIN, "run", CLI, "meaningful", ...args], {
		cwd: repo.dir,
		env: process.env,
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function rawPlan(contents: string, name = "plan.txt"): string {
	const file = join(fixtures.tmp("dg-meaningful-plan-"), name);
	writeFileSync(file, contents);
	return file;
}

function textPlan(
	groups: Array<{ msg: string; files: readonly string[]; author?: string }>,
): string {
	return rawPlan(
		groups
			.map(({ msg, files, author }) =>
				[
					`MSG: ${msg}`,
					...(author ? [`AUTHOR: ${author}`] : []),
					"FILES:",
					...files,
					"",
				].join("\n"),
			)
			.join("\n"),
	);
}

function jsonPlan(groups: JsonGroup[], base?: string): string {
	return rawPlan(
		JSON.stringify({ ...(base ? { base } : {}), groups }),
		"plan.json",
	);
}

function snapshot(repo: Repo) {
	return {
		head: git(repo, ["rev-parse", "HEAD"]),
		tree: git(repo, ["rev-parse", "HEAD^{tree}"]),
		history: git(repo, ["log", "--format=%H", "--all"]),
		status: git(repo, ["status", "--porcelain"]),
		remote: git(repo, ["ls-remote", "origin"]),
	};
}

function expectApplied(
	repo: Repo,
	result: ReturnType<typeof runMeaningful>,
	backup: string,
	tree: string,
): void {
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe(`${backup}\n`);
	expect(result.stderr).toContain(`meaningful: backup ref = ${backup}\n`);
	expect(git(repo, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
	expect(git(repo, ["status", "--porcelain"])).toBe("");
	expect(git(repo, ["rev-parse", "@{u}"])).toBe(
		git(repo, ["rev-parse", "HEAD"]),
	);
}

describe("meaningful usage and import isolation", () => {
	test.each([
		{ args: [], status: 2, stream: "stdout", message: "Usage:" },
		{ args: ["--help"], status: 0, stream: "stdout", message: "Usage:" },
		{ args: ["-h"], status: 0, stream: "stdout", message: "Usage:" },
		{
			args: ["info", "--help"],
			status: 0,
			stream: "stdout",
			message: "Usage:",
		},
		{
			args: ["bogus"],
			status: 2,
			stream: "stderr",
			message: "unknown subcommand 'bogus'",
		},
		{
			args: ["apply"],
			status: 2,
			stream: "stderr",
			message: "usage: apply [--base <ref>] <plan-file>",
		},
		{
			args: ["apply-json"],
			status: 2,
			stream: "stderr",
			message: "usage: apply-json [--base <ref>] <plan-file>",
		},
		{
			args: ["abort"],
			status: 2,
			stream: "stderr",
			message: "usage: abort <backup-ref>",
		},
		{
			args: ["info", "--base"],
			status: 2,
			stream: "stderr",
			message: "--base requires a ref argument",
		},
		{
			args: ["info", "--base", "--wat"],
			status: 2,
			stream: "stderr",
			message: "--base requires a ref argument",
		},
	])(
		"preserves measured status and streams for $args",
		({ args, status, stream, message }) => {
			const repo = makeRepo();
			const before = snapshot(repo);
			const result = runMeaningful(repo, args);
			expect(result.exitCode).toBe(status);
			expect(result[stream as "stdout" | "stderr"]).toContain(message);
			if (stream === "stdout") expect(result.stdout).toContain("apply-json");
			expect(result[stream === "stdout" ? "stderr" : "stdout"]).toBe("");
			expect(snapshot(repo)).toEqual(before);
		},
	);

	test("imports the meaningful domain without running commands or creating state", () => {
		const cwd = fixtures.tmp("dg-meaningful-import-");
		const before = [process.env.AI_STATE_DIR!, process.env.AI_SCRATCH_DIR!].map(
			(dir) => readdirSync(dir),
		);
		const domain = join(import.meta.dir, "../src/meaningful/index.ts");
		const proc = Bun.spawnSync(
			[
				BUN_BIN,
				"-e",
				`await import(${JSON.stringify(domain)}); console.log("import complete");`,
			],
			{ cwd, env: process.env },
		);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("import complete\n");
		expect(proc.stderr.toString()).toBe("");
		expect(readdirSync(cwd)).toEqual([]);
		expect(
			[process.env.AI_STATE_DIR!, process.env.AI_SCRATCH_DIR!].map((dir) =>
				readdirSync(dir),
			),
		).toEqual(before);
	});
});

describe("meaningful info", () => {
	test("reports the full schema, ordered commits, human authors and default remote base", () => {
		const repo = makeRepo();
		const first = commit(
			repo,
			{ "a.ts": "one\n" },
			"feat: one",
			"Alice <alice@example.invalid>",
		);
		const second = commit(
			repo,
			{ "a.ts": "two\n", "b.ts": "two\n" },
			"feat: two",
			"Bob <bob@example.invalid>",
		);
		const third = commit(
			repo,
			{ "a.ts": "three\n", "ai.ts": "AI\n" },
			"chore: AI",
			"Claude <ai@example.invalid>",
		);
		commit(
			repo,
			{ "a.ts": "four\n" },
			"fix: four",
			"Alice <alice@example.invalid>",
		);
		const result = runMeaningful(repo, ["--json", "info"]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const info = JSON.parse(result.stdout);
		expect(Object.keys(info).sort()).toEqual([
			"ahead",
			"base_branch",
			"base_sha",
			"branch",
			"commits",
			"file_authors",
			"files",
			"head_sha",
			"upstream",
		]);
		expect(info).toMatchObject({
			branch: "feature/meaningful",
			base_branch: "main",
			base_sha: repo.base,
			head_sha: git(repo, ["rev-parse", "HEAD"]),
			upstream: "origin/feature/meaningful",
			ahead: 4,
		});
		expect(info.commits).toEqual([
			{ sha: first, author: "Alice", subject: "feat: one" },
			{ sha: second, author: "Bob", subject: "feat: two" },
			{ sha: third, author: "Claude", subject: "chore: AI" },
			{ sha: info.head_sha, author: "Alice", subject: "fix: four" },
		]);
		expect(info.files).toEqual(["a.ts", "ai.ts", "b.ts"]);
		expect(info.file_authors).toEqual({
			"a.ts": ["Alice", "Bob"],
			"b.ts": ["Bob"],
		});
	});

	test("returns empty arrays and absent upstream when there is no branch work", () => {
		const repo = makeRepo(undefined, false);
		const result = runMeaningful(repo, ["info", "--base", "base"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			upstream: "",
			ahead: 0,
			commits: [],
			files: [],
			file_authors: {},
			base_sha: repo.base,
		});
	});

	test("uses an explicit base ref to narrow the history and files", () => {
		const repo = makeRepo();
		const first = commit(repo, { "c1.ts": "one\n" }, "feat: c1");
		commit(repo, { "c2.ts": "two\n" }, "feat: c2");
		const all = runMeaningful(repo, ["info", "--base", repo.base]);
		const narrowed = runMeaningful(repo, ["info", "--base", first]);
		expect(all.exitCode).toBe(0);
		expect(narrowed.exitCode).toBe(0);
		expect(JSON.parse(all.stdout)).toMatchObject({
			ahead: 2,
			files: ["c1.ts", "c2.ts"],
		});
		expect(JSON.parse(narrowed.stdout)).toMatchObject({
			ahead: 1,
			files: ["c2.ts"],
			base_sha: first,
		});
	});

	test("merge-bases a moved non-ancestor base without importing its unrelated files", () => {
		const repo = makeRepo();
		commit(repo, { "feature.ts": "feature\n" });
		git(repo, ["checkout", "-q", "main"]);
		commit(repo, { "remote-only.ts": "remote\n" }, "feat: unrelated main work");
		git(repo, ["checkout", "-q", "feature/meaningful"]);
		const result = runMeaningful(repo, ["info", "--base", "main"]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain(
			"is not an ancestor of HEAD; using merge-base",
		);
		expect(JSON.parse(result.stdout)).toMatchObject({
			base_sha: repo.base,
			ahead: 1,
			files: ["feature.ts"],
		});
	});

	test.each(["detached", "missing-base"])(
		"rejects %s without modifying the repository",
		(mode) => {
			const repo = makeRepo();
			if (mode === "detached") git(repo, ["checkout", "--detach", "-q"]);
			const before = snapshot(repo);
			const result = runMeaningful(repo, [
				"info",
				"--base",
				mode === "detached" ? "base" : "no-such-base",
			]);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(
				mode === "detached" ? "detached HEAD" : "cannot find merge-base",
			);
			expect(snapshot(repo)).toEqual(before);
		},
	);
});

describe("meaningful apply text plans", () => {
	test("preserves the original tree when a group renames and edits existing files", () => {
		const repo = makeRepo({
			"old.ts": "export const x = 1;\n",
			"other.ts": "export const y = 2;\n",
		});
		git(repo, ["mv", "old.ts", "new.ts"]);
		const backup = commit(
			repo,
			{ "other.ts": "export const y = 99;\n" },
			"refactor: rename and edit",
		);
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const info = runMeaningful(repo, ["info", "--base", repo.base]);
		expect(info.exitCode).toBe(0);
		expect(JSON.parse(info.stdout).files).toEqual([
			"new.ts",
			"old.ts",
			"other.ts",
		]);
		const result = runMeaningful(repo, [
			"apply",
			"--base",
			repo.base,
			textPlan([
				{
					msg: "refactor(scope): rename and edit",
					files: ["old.ts", "new.ts", "other.ts"],
				},
			]),
		]);
		expectApplied(repo, result, backup, tree);
	});

	test.each([
		{ label: "omitted", files: ["a.ts"] },
		{ label: "extra", files: ["a.ts", "b.ts", "ghost.ts"] },
	])("rejects $label files before changing history", ({ files }) => {
		const repo = makeRepo();
		commit(repo, { "a.ts": "a\n", "b.ts": "b\n" });
		const before = snapshot(repo);
		const result = runMeaningful(repo, [
			"apply",
			"--base",
			repo.base,
			textPlan([{ msg: "feat: files", files }]),
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("plan/diff mismatch");
		expect(result.stderr).toContain("expected files:\na.ts\nb.ts\n");
		expect(snapshot(repo)).toEqual(before);
	});

	test("reshapes only the commits above an explicit base and preserves earlier history", () => {
		const repo = makeRepo();
		const explicitBase = commit(
			repo,
			{ "base-file.ts": "base\n" },
			"chore: base file",
		);
		const backup = commit(repo, { "work.ts": "work\n" }, "feat: work");
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const result = runMeaningful(repo, [
			"apply",
			textPlan([{ msg: "feat(scope): work", files: ["work.ts"] }]),
			"--base",
			explicitBase,
		]);
		expectApplied(repo, result, backup, tree);
		expect(git(repo, ["rev-parse", "HEAD~1"])).toBe(explicitBase);
		expect(git(repo, ["rev-list", "--count", `${explicitBase}..HEAD`])).toBe(
			"1",
		);
	});

	test("preserves text-plan author, contiguous body, human trailers and separate groups", () => {
		const repo = makeRepo();
		const backup = commit(repo, { "a.ts": "a\n", "b.ts": "b\n" });
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const subject = 'feat: literal $(touch never) `echo nope` ; & "quotes"';
		const body = "Body with $HOME and a backslash \\ intact.";
		const human = "Co-Authored-By: Human <human@example.invalid>";
		const plan = textPlan([
			{
				msg: `${subject}\n${body}\n${human}\nCo-Authored-By: Claude <noreply@anthropic.com>`,
				author: "Alice <alice@example.invalid>",
				files: ["a.ts"],
			},
			{ msg: "feat: second", files: ["b.ts"] },
		]);
		const result = runMeaningful(repo, ["apply", "--base", repo.base, plan]);
		expectApplied(repo, result, backup, tree);
		expect(git(repo, ["log", "-1", "--format=%B", "HEAD~1"])).toBe(
			`${subject}\n${body}\n${human}`,
		);
		expect(git(repo, ["log", "-1", "--format=%an <%ae>", "HEAD~1"])).toBe(
			"Alice <alice@example.invalid>",
		);
		expect(
			git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD~1"]),
		).toBe("a.ts");
		expect(
			git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]),
		).toBe("b.ts");
		expect(existsSync(join(repo.dir, "never"))).toBe(false);
	});
});

describe("meaningful apply-json", () => {
	test("keeps body paragraphs and human coauthors, removes AI trailers and honors authors", () => {
		const repo = makeRepo();
		const backup = commit(repo, { "page.tsx": "page\n", "a.ts": "a\n" });
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const group: JsonGroup = {
			subject: "feat(scope): rework page",
			body: "First paragraph.\n\nSecond paragraph.",
			author: "Alice <alice@example.invalid>",
			coauthors: [
				"Real Human <human@example.com>",
				"Claude <noreply@anthropic.com>",
				"Other AI <noreply@anthropic.com>",
			],
			files: ["page.tsx"],
		};
		const result = runMeaningful(repo, [
			"apply-json",
			"--base",
			repo.base,
			jsonPlan([group, { subject: "feat(scope): add a", files: ["a.ts"] }]),
		]);
		expectApplied(repo, result, backup, tree);
		expect(git(repo, ["log", "--format=%B", "-1", "HEAD~1"])).toBe(
			`${group.subject}\n\n${group.body}\n\nCo-Authored-By: ${group.coauthors![0]}`,
		);
		expect(git(repo, ["log", "--format=%an <%ae>", "-1", "HEAD~1"])).toBe(
			group.author!,
		);
		expect(git(repo, ["log", "--format=%s", "-1", "HEAD"])).toBe(
			"feat(scope): add a",
		);
	});

	test("stages bracketed pathspec-magic filenames literally", () => {
		const repo = makeRepo();
		const file = "entity/[entityId]/merge/page.tsx";
		const backup = commit(repo, { [file]: "content\n" });
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const result = runMeaningful(repo, [
			"apply-json",
			"--base",
			repo.base,
			jsonPlan([{ subject: "feat(entity): merge page", files: [file] }]),
		]);
		expectApplied(repo, result, backup, tree);
	});

	test("preserves literal subject/body shell metacharacters and grouped paths with spaces", () => {
		const repo = makeRepo();
		const firstFile = "src/[id]/file with spaces.ts";
		const secondFile = "src/literal$(touch never).ts";
		const backup = commit(repo, {
			[firstFile]: "first\n",
			[secondFile]: "second\n",
			"other.ts": "third\n",
		});
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const subject = 'feat: ✨ "quotes" $(touch never) `echo never` & ;';
		const body =
			"Paragraph one with $HOME \\ paths.\n\nParagraph two <html> & 'quotes'.";
		const result = runMeaningful(repo, [
			"apply-json",
			"--base",
			repo.base,
			jsonPlan([
				{ subject, body, files: [firstFile, secondFile] },
				{ subject: "feat: other", files: ["other.ts"] },
			]),
		]);
		expectApplied(repo, result, backup, tree);
		expect(git(repo, ["log", "--format=%B", "-1", "HEAD~1"])).toBe(
			`${subject}\n\n${body}`,
		);
		expect(
			git(repo, [
				"diff-tree",
				"--no-commit-id",
				"--name-only",
				"-r",
				"HEAD~1",
			]).split("\n"),
		).toEqual([firstFile, secondFile].sort());
		expect(existsSync(join(repo.dir, "never"))).toBe(false);
	});

	test("rejects a mismatched file union and leaves all history untouched", () => {
		const repo = makeRepo();
		commit(repo, { "f.ts": "f\n", "g.ts": "g\n" });
		const before = snapshot(repo);
		const result = runMeaningful(repo, [
			"apply-json",
			"--base",
			repo.base,
			jsonPlan([{ subject: "feat: only f", files: ["f.ts"] }]),
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("plan/diff mismatch");
		expect(snapshot(repo)).toEqual(before);
	});

	test("honors the plan base when the command line omits --base", () => {
		const repo = makeRepo();
		const backup = commit(repo, { "h.ts": "h\n" });
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const result = runMeaningful(repo, [
			"apply-json",
			jsonPlan([{ subject: "feat: add h", files: ["h.ts"] }], repo.base),
		]);
		expectApplied(repo, result, backup, tree);
	});

	test("gives an explicit command-line base precedence over the plan base", () => {
		const repo = makeRepo();
		const explicitBase = commit(
			repo,
			{ "preserved.ts": "preserved\n" },
			"feat: preserve this",
		);
		const backup = commit(repo, { "work.ts": "work\n" });
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const result = runMeaningful(repo, [
			"apply-json",
			"--base",
			explicitBase,
			jsonPlan([{ subject: "feat: work", files: ["work.ts"] }], repo.base),
		]);
		expectApplied(repo, result, backup, tree);
		expect(git(repo, ["rev-parse", "HEAD~1"])).toBe(explicitBase);
	});

	test.each([
		{ plan: "{", message: "invalid JSON" },
		{ plan: "null", message: 'object with a "groups" array' },
		{ plan: "{}", message: 'object with a "groups" array' },
		{ plan: '{"groups":[]}', message: "plan has no groups" },
		{
			plan: '{"groups":[{"files":["z.ts"]}]}',
			message: 'missing/invalid "subject"',
		},
		{
			plan: '{"groups":[{"subject":"  ","files":["z.ts"]}]}',
			message: 'missing/invalid "subject"',
		},
		{
			plan: '{"groups":[{"subject":"feat: z"}]}',
			message: 'missing/invalid "files" array',
		},
		{
			plan: '{"groups":[{"subject":"feat: z","files":[]}]}',
			message: 'missing/invalid "files" array',
		},
		{
			plan: '{"groups":[{"subject":"feat: z","files":[1]}]}',
			message: 'missing/invalid "files" array',
		},
		{
			plan: '{"groups":[{"subject":"feat: z","files":[" "]}]}',
			message: 'missing/invalid "files" array',
		},
		{
			plan: '{"groups":[{"subject":"feat: z","files":["z.ts"],"author":"invalid"}]}',
			message: 'malformed group 1 "author"',
		},
		{
			plan: '{"groups":[{"subject":"feat: z","files":["z.ts"],"coauthors":["invalid"]}]}',
			message: "malformed group 1 coauthor",
		},
	])(
		"rejects malformed JSON plans with usage status: $message / $plan",
		({ plan, message }) => {
			const repo = makeRepo();
			commit(repo, { "z.ts": "z\n" });
			const before = snapshot(repo);
			const result = runMeaningful(repo, [
				"apply-json",
				"--base",
				repo.base,
				rawPlan(plan, "plan.json"),
			]);
			expect(result.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(message);
			expect(snapshot(repo)).toEqual(before);
		},
	);
});

describe("meaningful preflight, backup and rollback", () => {
	test.each(["apply", "apply-json"])(
		"%s refuses dirty work without changing history or dirty content",
		(verb) => {
			const repo = makeRepo();
			commit(repo, { "a.ts": "committed\n" });
			write(repo, "a.ts", "dirty\n");
			write(repo, "untracked.ts", "keep me\n");
			const before = snapshot(repo);
			const plan =
				verb === "apply"
					? textPlan([{ msg: "feat: a", files: ["a.ts"] }])
					: jsonPlan([{ subject: "feat: a", files: ["a.ts"] }]);
			const result = runMeaningful(repo, [verb, "--base", repo.base, plan]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("working tree has uncommitted changes");
			expect(result.stderr).not.toContain("backup ref");
			expect(snapshot(repo)).toEqual(before);
			expect(readFileSync(join(repo.dir, "a.ts"), "utf8")).toBe("dirty\n");
			expect(readFileSync(join(repo.dir, "untracked.ts"), "utf8")).toBe(
				"keep me\n",
			);
		},
	);

	test.each(["detached", "missing-base"])(
		"apply rejects %s before resetting HEAD",
		(mode) => {
			const repo = makeRepo();
			commit(repo, { "a.ts": "a\n" });
			if (mode === "detached") git(repo, ["checkout", "--detach", "-q"]);
			const before = snapshot(repo);
			const result = runMeaningful(repo, [
				"apply",
				"--base",
				mode === "detached" ? "base" : "no-such-base",
				textPlan([{ msg: "feat: a", files: ["a.ts"] }]),
			]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(
				mode === "detached" ? "detached HEAD" : "cannot resolve base ref",
			);
			expect(snapshot(repo)).toEqual(before);
		},
	);

	test.each(["apply", "apply-json"])(
		"%s reports a missing plan as status 1",
		(verb) => {
			const repo = makeRepo();
			const missing = join(fixtures.tmp("dg-meaningful-missing-"), "no-plan");
			const before = snapshot(repo);
			const result = runMeaningful(repo, [verb, missing]);
			expect(result).toEqual({
				exitCode: 1,
				stdout: "",
				stderr: `error: plan file not found: ${missing}\n`,
			});
			expect(snapshot(repo)).toEqual(before);
		},
	);

	test("rejects empty text plans and malformed AUTHOR lines before changing history", () => {
		const repo = makeRepo();
		commit(repo, { "a.ts": "a\n" });
		const before = snapshot(repo);
		for (const [text, status, message] of [
			["", 1, "no groups parsed from plan"],
			[
				"MSG: feat: a\nAUTHOR: invalid\nFILES:\na.ts\n",
				2,
				"malformed AUTHOR line",
			],
		] as const) {
			const result = runMeaningful(repo, [
				"apply",
				"--base",
				repo.base,
				rawPlan(text),
			]);
			expect(result.exitCode).toBe(status);
			expect(result.stderr).toContain(message);
			expect(snapshot(repo)).toEqual(before);
		}
	});

	test("restores the backup when a post-commit hook makes the reshaped tree dirty", () => {
		const repo = makeRepo();
		const backup = commit(repo, { "a.ts": "a\n" });
		const before = snapshot(repo);
		const hook = join(repo.dir, ".git/hooks/post-commit");
		writeFileSync(hook, "#!/bin/sh\nprintf 'hook mutation\\n' >> a.ts\n");
		chmodSync(hook, 0o755);
		const result = runMeaningful(repo, [
			"apply-json",
			"--base",
			repo.base,
			jsonPlan([{ subject: "feat: rewritten", files: ["a.ts"] }]),
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`backup ref = ${backup}`);
		expect(result.stderr).toContain(`backup restored: ${backup}`);
		expect(snapshot(repo)).toEqual(before);
		expect(readFileSync(join(repo.dir, "a.ts"), "utf8")).toBe("a\n");
	});

	test("returns validation status for an empty group and permits abort using the emitted backup SHA", () => {
		const repo = makeRepo();
		const backup = commit(repo, { "a.ts": "a\n" });
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const remote = git(repo, ["ls-remote", "origin"]);
		const plan = jsonPlan([
			{ subject: "feat: first", files: ["a.ts"] },
			{ subject: "feat: duplicate", files: ["a.ts"] },
		]);
		const result = runMeaningful(repo, [
			"apply-json",
			"--base",
			repo.base,
			plan,
		]);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("group 2 has no staged changes");
		expect(result.stderr).toContain(`Restore with: git reset --hard ${backup}`);
		expect(git(repo, ["ls-remote", "origin"])).toBe(remote);
		const aborted = runMeaningful(repo, ["abort", backup]);
		expect(aborted).toEqual({ exitCode: 0, stdout: "", stderr: "" });
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(backup);
		expect(git(repo, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
		expect(git(repo, ["status", "--porcelain"])).toBe("");
	});

	test.each(["main", "master", "develop"])(
		"refuses to reshape or push protected branch %s",
		(branch) => {
			const repo = makeRepo(undefined, false);
			if (branch === "main") git(repo, ["checkout", "-q", "main"]);
			else {
				git(repo, ["checkout", "-q", "-b", branch]);
				git(repo, ["push", "-u", "origin", branch]);
				git(repo, [
					"symbolic-ref",
					"refs/remotes/origin/HEAD",
					`refs/remotes/origin/${branch}`,
				]);
			}
			const head = commit(repo, { "a.ts": "a\n" });
			const remote = git(repo, ["ls-remote", "origin"]);
			const result = runMeaningful(repo, [
				"apply-json",
				"--base",
				repo.base,
				jsonPlan([{ subject: "feat: rewritten", files: ["a.ts"] }]),
			]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(
				`refusing to force-push protected branch '${branch}'`,
			);
			expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
			expect(git(repo, ["ls-remote", "origin"])).toBe(remote);
		},
	);

	test.each([true, false])(
		"pushes an identical tree with tracked upstream = %s and abort leaves the remote unchanged",
		(tracked) => {
			const repo = makeRepo(undefined, tracked);
			const backup = commit(repo, { "a.ts": "a\n", "b.ts": "b\n" });
			if (tracked) git(repo, ["push"]);
			const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
			const result = runMeaningful(repo, [
				"apply-json",
				"--base",
				repo.base,
				jsonPlan([
					{ subject: "feat: first", files: ["a.ts"] },
					{ subject: "feat: second", files: ["b.ts"] },
				]),
			]);
			expectApplied(repo, result, backup, tree);
			expect(result.stderr).toContain(
				tracked
					? "force-push-with-lease..."
					: "no upstream; setting and pushing.",
			);
			const remote = git(repo, ["ls-remote", "origin"]);
			// A named backup ref is accepted too; abort remains deliberately local.
			git(repo, ["update-ref", "refs/meaningful/backups/original", backup]);
			write(repo, "a.ts", "discard this dirty edit\n");
			const aborted = runMeaningful(repo, [
				"abort",
				"refs/meaningful/backups/original",
			]);
			expect(aborted).toEqual({ exitCode: 0, stdout: "", stderr: "" });
			expect(git(repo, ["rev-parse", "HEAD"])).toBe(backup);
			expect(git(repo, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
			expect(git(repo, ["ls-remote", "origin"])).toBe(remote);
		},
	);

	test("preserves the backup and remote on push failure so abort can recover original history", () => {
		const repo = makeRepo();
		const backup = commit(repo, { "a.ts": "a\n" });
		const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
		const remote = git(repo, ["ls-remote", "origin"]);
		const hook = join(repo.bare, "hooks/pre-receive");
		writeFileSync(
			hook,
			"#!/bin/sh\nprintf 'fixture push rejected\\n' >&2\nexit 1\n",
		);
		chmodSync(hook, 0o755);
		const result = runMeaningful(repo, [
			"apply-json",
			"--base",
			repo.base,
			jsonPlan([{ subject: "feat: rewritten", files: ["a.ts"] }]),
		]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(`backup ref = ${backup}`);
		expect(result.stderr).toContain("fixture push rejected");
		expect(git(repo, ["ls-remote", "origin"])).toBe(remote);
		expect(git(repo, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
		expect(runMeaningful(repo, ["abort", backup]).exitCode).toBe(0);
		expect(git(repo, ["rev-parse", "HEAD"])).toBe(backup);
	});
});


// Bootstrap is copied into an owned synthetic checkout. No download utility or
// legacy helper is installed in this suite's PATH.
const compiledBootstrapTools = ["sh", "mktemp", "find", "grep", "mkdir", "basename", "rm", "dirname", "cp", "chmod", "sort", "wc", "tr"].map((name) => {
 const path = Bun.which(name);
 if (!path) throw new Error(`Missing bootstrap fixture utility: ${name}`);
 return { name, path };
});

const INSTALLED_FILES = [
 "deps-upgrade/SKILL.md",
 "deps-upgrade/references/ecosystems.md",
 "deps-upgrade/references/steps.md",
 "meaningful/SKILL.md",
 "meaningful/references/example-plan.json",
 "meaningful/references/helper-api.md",
 "meaningful/references/proposal-format.md",
];

describe("relocated compiled meaningful and deps-upgrade", () => {
 let bundle: string;
 let binary: string;
 let skills: string;
 let stage: string;
 let expectedFiles: Map<string, Buffer>;

 beforeAll(() => {
  bundle = makeTempDir("dg meaningful deps compiled ");
  stage = join(bundle, "build stage with spaces");
  const install = join(bundle, "relocated installation with spaces");
  skills = join(install, "skills");
  binary = join(install, "bin", "dg-skills");
  mkdirSync(stage, { recursive: true });
  mkdirSync(dirname(binary), { recursive: true });
  const compiled = join(stage, "dg-skills");
  const build = Bun.spawnSync([BUN_BIN, join(import.meta.dir, "../build.ts"), "--outfile", compiled], { cwd: join(import.meta.dir, "../../.."), env: process.env });
  if (build.exitCode !== 0) throw new Error(`Compile failed: ${build.stderr.toString()}`);
  renameSync(compiled, binary);

  const copiedRepo = join(stage, "synthetic source checkout");
  const bootstrap = join(copiedRepo, "pkg", "skills-cli", "bootstrap.sh");
  mkdirSync(dirname(bootstrap), { recursive: true });
  cpSync(join(import.meta.dir, "../bootstrap.sh"), bootstrap);
  for (const skill of ["meaningful", "deps-upgrade"]) cpSync(join(import.meta.dir, "../../../plugins/dg/skills", skill), join(copiedRepo, "plugins/dg/skills", skill), { recursive: true });
  expectedFiles = new Map(INSTALLED_FILES.map((file) => [file, readFileSync(join(copiedRepo, "plugins/dg/skills", file))]));
  const tools = join(stage, "bootstrap tools");
  const cwd = join(stage, "external install cwd");
  const home = join(stage, "bootstrap home");
  for (const dir of [tools, cwd, home]) mkdirSync(dir, { recursive: true });
  for (const tool of compiledBootstrapTools) symlinkSync(tool.path, join(tools, tool.name));
  const installResult = Bun.spawnSync([join(tools, "sh"), bootstrap, "--skills-only"], { cwd, env: { HOME: home, PATH: tools, TMPDIR: stage, DG_SKILLS_DEST: skills } });
  if (installResult.exitCode !== 0) throw new Error(`Skills-only fixture install failed: ${installResult.stderr.toString()}`);
  rmSync(stage, { recursive: true, force: true });
 }, 120_000);

 afterAll(() => { if (bundle) rmSync(bundle, { recursive: true, force: true }); });

 function compiledRepo(seed: Record<string, string> = { "README.md": "base\n" }) {
  return makeRepo(seed, true, join(fixtures.tmp("dg compiled resources "), "repo with spaces"));
 }

 function runCompiled(args: readonly string[], cwd: string, env: Record<string, string> = {}, stdin?: string) {
  const proc = Bun.spawnSync([binary, ...args], { cwd, env: { ...process.env, ...env, DG_SKILLS_DIR: skills, CLAUDE_PLUGIN_ROOT: dirname(skills), NODE_OPTIONS: undefined, BUN_OPTIONS: undefined }, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
 }

 test("installs all seven skill files and runs their actual bootstrap snippets after build-stage removal", () => {
  expect(existsSync(stage)).toBe(false);
  const installed = readdirSync(skills, { recursive: true, encoding: "utf8" }).map(String).filter((file) => statSync(join(skills, file)).isFile()).sort();
  expect(installed).toEqual(INSTALLED_FILES);
  for (const [file, bytes] of expectedFiles) {
   expect(readFileSync(join(skills, file)).equals(bytes)).toBe(true);
   expect(statSync(join(skills, file)).mode & 0o777).toBe(0o644);
  }
  const cwd = fixtures.tmp("dg external docs cwd ");
  const bin = join(process.env.HOME!, ".dg/bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(binary, join(bin, "dg-skills"));
  for (const skill of ["meaningful", "deps-upgrade"]) {
   const text = readFileSync(join(skills, skill, "SKILL.md"), "utf8");
   const snippet = text.match(/```bash\n([\s\S]*?)```/)?.[1];
   expect(snippet).toBeTruthy();
   const proc = Bun.spawnSync(["sh", "-c", `${snippet}\nexec "$DG" "$@"`, "installed-skill", skill, "--help"], { cwd, env: { ...process.env, CLAUDE_PLUGIN_ROOT: dirname(skills) } });
   expect(proc.exitCode).toBe(0);
   expect(proc.stdout.toString()).toContain(`Usage: ${skill} <subcommand>`);
   expect(proc.stderr.toString()).toBe("");
  }
 });

 test("regroups literal history with authors, pushes to local origin, and aborts to its reported backup", () => {
  const repo = compiledRepo();
  const first = "src/[id]/file with spaces.ts";
  const second = "other.ts";
  const backup = commit(repo, { [first]: "first\n", [second]: "second\n" });
  const tree = git(repo, ["rev-parse", "HEAD^{tree}"]);
  const subject = 'feat: ✨ "quotes" $(touch never) `echo never` & ;';
  const body = "Paragraph with $HOME and \\ intact.\n\nSecond paragraph <html>.";
  const author = "Alice Example <alice@example.invalid>";
  const coauthor = "Human Example <human@example.invalid>";
  const plan = rawPlan(JSON.stringify({ base: repo.base, groups: [{ subject, body, author, coauthors: [coauthor], files: [first] }, { subject: "feat: second group", files: [second] }] }), "chosen plan with spaces.json");
  const info = runCompiled(["meaningful", "info", "--base", repo.base], repo.dir);
  expect(info.exitCode).toBe(0);
  expect(JSON.parse(info.stdout)).toMatchObject({ head_sha: backup, files: [second, first].sort() });
  const apply = runCompiled(["meaningful", "apply-json", plan], repo.dir);
  expectApplied(repo, apply, backup, tree);
  expect(git(repo, ["log", "-1", "--format=%B", "HEAD~1"])).toBe(`${subject}\n\n${body}\n\nCo-Authored-By: ${coauthor}`);
  expect(git(repo, ["log", "-1", "--format=%an <%ae>", "HEAD~1"])).toBe(author);
  expect(git(repo, ["rev-list", "--count", `${repo.base}..HEAD`])).toBe("2");
  expect(existsSync(join(repo.dir, "never"))).toBe(false);
  const remote = git(repo, ["ls-remote", "origin"]);
  const abort = runCompiled(["meaningful", "abort", backup], repo.dir);
  expect(abort).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(git(repo, ["rev-parse", "HEAD"])).toBe(backup);
  expect(git(repo, ["rev-parse", "HEAD^{tree}"])).toBe(tree);
  expect(git(repo, ["ls-remote", "origin"])).toBe(remote);
 });

 test("prepares an actual dependency worktree and shares audit snapshots from the main checkout after changing cwd", () => {
  const repo = compiledRepo({ "package.json": "{}", "package-lock.json": "{}" });
  const before = JSON.stringify({ metadata: { vulnerabilities: { high: 2, total: 2 } } });
  const after = JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } });
  const tools = fixtures.tmp("dg compiled audit tools ");
  writeFakeCli(tools, "npm", '#!/bin/sh\n[ "$*" = "audit --json" ] || exit 91\nprintf "%s" "$FAKE_AUDIT_PAYLOAD"\nexit 1\n');
  const prepare = runCompiled(["deps-upgrade", "prepare"], repo.dir);
  expect(prepare.exitCode).toBe(0);
  expect(prepare.stderr).toBe("");
  const path = prepare.stdout.match(/^  path:   (.+)$/m)?.[1];
  const branch = prepare.stdout.match(/^  branch: (.+)$/m)?.[1];
  expect(path).toBeTruthy();
  expect(branch).toMatch(/^drb\/chore\/deps_update_\d{8}_\d{6}$/);
  expect(git({ ...repo, dir: path! }, ["branch", "--show-current"])).toBe(branch!);
  const state = stateDir("deps-upgrade", { cwd: repo.dir });
  expect(stateDir("deps-upgrade", { cwd: path! })).toBe(state);
  expect(readFileSync(join(state, "branch.txt"), "utf8")).toBe(`${branch}\n`);
  const firstAudit = runCompiled(["deps-upgrade", "audit"], repo.dir, { FAKE_AUDIT_PAYLOAD: before });
  expect(firstAudit.exitCode).toBe(0);
  expect(firstAudit.stdout).toContain("high: 2");
  const nextAudit = runCompiled(["deps-upgrade", "audit"], path!, { FAKE_AUDIT_PAYLOAD: after });
  expect(nextAudit.exitCode).toBe(0);
  expect(readFileSync(join(state, "audit-before.json"), "utf8")).toBe(before);
  expect(readFileSync(join(state, "audit-after.json"), "utf8")).toBe(after);
  const summary = runCompiled(["deps-upgrade", "summary"], path!);
  expect(summary.exitCode).toBe(0);
  expect(summary.stdout).toContain("Vulnerabilities: 2 total (2 high) → 0 total");
  const cooldown = runCompiled(["deps-upgrade", "cooldown", "pkg", "1", "2", "--cooldown-days", "0", "--ecosystem", "npm"], path!);
  expect(cooldown.exitCode).toBe(0);
  expect(JSON.parse(cooldown.stdout)).toEqual({ pkg: "pkg", status: "ok", version: "2" });
 });

 test.each(["github", "gitlab"] as const)("lists dependencies and creates draft/ready pull requests on fake %s with literal stdin", (provider) => {
  const repo = compiledRepo();
  const tools = fixtures.tmp("dg compiled provider tools ");
  const log = join(tools, "calls.jsonl");
  const id = 77;
  const url = provider === "github" ? `https://github.com/acme/widgets/pull/${id}` : `https://gitlab.com/acme/widgets/-/merge_requests/${id}`;
  const pr = { number: id, title: "Dependency update", url, state: "OPEN", headRefName: "dependabot/pkg", baseRefName: "main", body: "notes", mergedAt: null };
  const mr = { iid: id, title: "Dependency update", web_url: url, state: "opened", source_branch: "renovate/pkg", target_branch: "main", description: "notes", merged_at: null };
  const name = provider === "github" ? "gh" : "glab";
  writeFakeCli(tools, name, `#!${BUN_BIN}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const body = args[0] === "pr" && args[1] === "create" ? await Bun.stdin.text() : "";
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, body }) + "\\n");
if (args[1] === "list") console.log(JSON.stringify(${JSON.stringify([provider === "github" ? pr : mr])}));
else if (args[1] === "create") console.log(${JSON.stringify(url)});
else if (args[1] === "view") console.log(args.includes("--jq") ? ${JSON.stringify(url)} : JSON.stringify(${JSON.stringify(provider === "github" ? pr : mr)}));
else if (args[1] === "checks") console.log(JSON.stringify([{ name: "build", bucket: "pass" }]));
else if (args[1] !== "ready") process.exit(91);
`);
  const env = { AI_VCS_PROVIDER: provider, ...(provider === "gitlab" ? { GLAB_BIN: join(tools, name), AI_RENOVATE_BOT_LOGIN: "configured-deps-bot" } : {}) };
  const list = runCompiled(["deps-upgrade", "list-prs"], repo.dir, env);
  expect(list.exitCode).toBe(0);
  expect(JSON.parse(list.stdout)).toMatchObject([{ number: id, headRefName: provider === "github" ? "dependabot/pkg" : "renovate/pkg" }]);
  const title = 'chore(deps): ✨ "quotes" $(touch never) `echo never` & ;';
  const body = '## Summary\nLiteral $HOME \\ "quotes" $(touch never) & <html>\n';
  for (const ready of [false, true]) {
   const push = runCompiled(["deps-upgrade", "push-pr", title, ...(ready ? ["--ready"] : [])], repo.dir, env, body);
   expect(push).toEqual({ exitCode: 0, stdout: `PR created: ${url}`, stderr: "" });
  }
  type Call = { args: string[]; body: string };
  const calls = (): Call[] => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const recorded = calls();
  const createCalls = recorded.filter((call) => call.args[1] === "create");
  expect(createCalls).toHaveLength(2);
  expect(createCalls[0].args).toContain("--draft");
  expect(createCalls[1].args).not.toContain("--draft");
  for (const call of createCalls) {
   expect(call.args).toContain(title);
   if (provider === "github") expect(call.body).toBe(body);
   else expect(call.args[call.args.indexOf("--description") + 1]).toBe(body);
  }
  if (provider === "github") {
   const ready = runCompiled(["deps-upgrade", "ready-when-green", String(id), "--interval-seconds", "0"], repo.dir, env);
   expect(ready.exitCode).toBe(0);
   expect(JSON.parse(ready.stdout)).toEqual({ status: "ready", url });
   expect(calls().some((call) => call.args.join(" ") === `pr ready ${id}`)).toBe(true);
  } else expect(recorded[0].args).toContain("configured-deps-bot");
  expect(git(repo, ["rev-parse", "@{u}"])).toBe(git(repo, ["rev-parse", "HEAD"]));
  expect(existsSync(join(repo.dir, "never"))).toBe(false);
 });
});
