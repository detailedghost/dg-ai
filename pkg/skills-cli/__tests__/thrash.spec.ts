import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { BACKENDS } from "../src/proxy";
import { EXIT } from "../src/utils/legacy-command";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { makeTempDir } from "./git-repo-fixtures";
import { compileProxyCli, proxyFixtures } from "./proxy-fixtures";

const CLI = join(import.meta.dir, "../src/index.ts");
const BUN_BIN = process.execPath;

cliFixtures.isolateCliTests();
const PR_URL = "https://github.com/acme/widgets/pull/12";

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

let createdDirs: string[];
let scratch: string;

beforeEach(() => {
	createdDirs = [];
	scratch = cliFixtures.tmp(createdDirs, "thrash-scratch-");
});

afterEach(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function run(
	args: string[],
	opts: {
		cwd?: string;
		env?: Record<string, string>;
		command?: "thrash" | "address";
	} = {},
): RunResult {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		AI_SCRATCH_DIR: scratch,
		...opts.env,
	};
	for (const key of ["GH_BIN", "GLAB_BIN", "AI_VCS_PROVIDER"]) {
		if (!(key in (opts.env ?? {}))) delete env[key];
	}
	const proc = Bun.spawnSync(
		[BUN_BIN, "run", CLI, opts.command ?? "thrash", ...args],
		{ cwd: opts.cwd ?? cliFixtures.tmp(createdDirs, "thrash-cwd-"), env },
	);
	return {
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		exitCode: proc.exitCode,
	};
}

function fixtureRepo(): string {
	const dir = makeTempDir("thrash-repo-");
	createdDirs.push(dir);
	cliFixtures.runGit(["init", "-q"], dir);
	cliFixtures.runGit(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
	cliFixtures.runGit(["config", "user.email", "t@t.t"], dir);
	cliFixtures.runGit(["config", "user.name", "T"], dir);
	mkdirSync(join(dir, "src"));
	cliFixtures.commitFile(
		dir,
		"src/a.ts",
		"const a = 1;\nconst b = 2;\nexport { a, b };\n",
		"chore: base",
	);
	cliFixtures.runGit(["checkout", "-q", "-b", "feature"], dir);
	writeFileSync(
		join(dir, "src/a.ts"),
		"const a = 1;\nconst b = 3;\nconst c = 4;\nexport { a, b };\n",
	);
	writeFileSync(join(dir, "untracked.txt"), "new\n");
	return dir;
}

function findingsFile(
	diff: { chunks: Array<{ findingsPath: string }> },
	findings: unknown[],
	chunk = 0,
): string {
	const path = diff.chunks[chunk].findingsPath;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`Report.\n\`\`\`json\n${JSON.stringify({ changed: "Adds a.", strengths: [], opportunities: [], findings })}\n\`\`\`\n`,
	);
	return path;
}

function fakeGh(script: string): { bin: string; log: string; stdin: string } {
	const dir = cliFixtures.tmp(createdDirs, "thrash-fake-gh-");
	writeFakeCli(dir, "gh", script);
	return {
		bin: join(dir, "gh"),
		log: join(dir, "calls.log"),
		stdin: join(dir, "stdin.txt"),
	};
}

const GH_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a, b };
`;

const ADDRESS_WORKFLOW = join(
	import.meta.dir,
	"../../../plugins/dg/skills/address/references/workflow.md",
);

const EMPTY_THREADS = JSON.stringify({
	data: {
		repository: {
			pullRequest: {
				reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
			},
		},
	},
});

describe("local mode", () => {
	test("diff accepts a file target and an explicit base without including unrelated untracked paths", () => {
		const repo = fixtureRepo();
		const result = run(["diff", "--base", "main", "src/a.ts"], { cwd: repo });
		expect(result.exitCode).toBe(EXIT.OK);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({
			target: "src/a.ts",
			mode: "local",
			root: repo,
			untracked: [],
		});
		expect(output.base).toBe(
			cliFixtures.runGit(["rev-parse", "main"], repo).trim(),
		);
		expect(readFileSync(output.diffPath, "utf8")).toContain(
			GH_DIFF.slice(GH_DIFF.indexOf("---")),
		);
		expect(readFileSync(output.contextPath, "utf8")).toContain(
			"Local review of src/a.ts against",
		);
	});

	test("diff . reviews the working tree against the fork point and lists untracked files", () => {
		const repo = fixtureRepo();
		const result = run(["diff", "."], { cwd: repo });
		expect(result.exitCode).toBe(EXIT.OK);
		const out = JSON.parse(result.stdout);
		expect(out.mode).toBe("local");
		expect(out.stats).toMatchObject({ files: 1, added: 2, deleted: 1 });
		expect(out.untracked).toEqual(["untracked.txt"]);
		expect(readFileSync(out.chunks[0].annotatedPath, "utf8")).toContain(
			"          2 + const b = 3;",
		);
	});

	test("compile JSON retains the review schema, min-tier and comment override, and creates distinct address files", () => {
		const repo = fixtureRepo();
		const diffResult = run(["diff", "."], { cwd: repo });
		expect(diffResult.exitCode).toBe(EXIT.OK);
		const diff = JSON.parse(diffResult.stdout);
		findingsFile(diff, [
			{ path: "src/a.ts", line: 2, tier: "critical", body: "Breaks callers." },
			{ path: "src/a.ts", line: 3, tier: "low", body: "Rename this." },
		]);
		const args = [
			"compile",
			".",
			"--diff",
			diff.diffPath,
			"--min-tier",
			"medium",
			"--comment",
			"--json",
		];
		const result = run(args, { cwd: repo });
		expect(result.exitCode).toBe(EXIT.OK);
		const output = JSON.parse(result.stdout);
		expect(Object.keys(output).sort()).toEqual([
			"addressFile",
			"reason",
			"reviewPath",
			"tally",
			"verdict",
		]);
		expect(output.verdict).toBe("comment");
		expect(output.tally).toEqual({
			critical: 1,
			high: 0,
			medium: 0,
			low: 1,
			nit: 0,
		});
		const stored = JSON.parse(readFileSync(output.reviewPath, "utf8"));
		expect(Object.keys(stored).sort()).toEqual(["review", "target"]);
		expect(stored.target).toBe(".");
		expect(stored.review).toMatchObject({
			verdict: output.verdict,
			tally: output.tally,
			comments: [{ path: "src/a.ts", newLine: 2, tier: "critical" }],
			dropped: [{ reason: "below-min-tier" }],
		});
		const addressBody = readFileSync(output.addressFile, "utf8");
		expect(addressBody).toContain("## src/a.ts:2\n\nseverity: high");
		expect(addressBody).not.toContain("Rename this.");
		const second = run(args, { cwd: repo });
		expect(second.exitCode).toBe(EXIT.OK);
		const next = JSON.parse(second.stdout);
		expect(next.addressFile).not.toBe(output.addressFile);
		expect(readFileSync(output.addressFile, "utf8")).toBe(addressBody);
		expect(readFileSync(next.addressFile, "utf8")).toBe(addressBody);
	});

	test("compile refuses a missing chunk findings file before writing a review or address file", () => {
		const repo = fixtureRepo();
		const diffResult = run(["diff", "."], { cwd: repo });
		expect(diffResult.exitCode).toBe(EXIT.OK);
		const diff = JSON.parse(diffResult.stdout);
		const result = run(["compile", ".", "--diff", diff.diffPath], {
			cwd: repo,
		});
		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"chunk 1 (whole diff) has no findings file",
		);
		expect(result.stderr).toContain(diff.chunks[0].findingsPath);
		expect(existsSync(diff.diffPath.replace(/\.diff$/, ".review.json"))).toBe(
			false,
		);
		expect(existsSync(join(repo, ".agents", "code-review"))).toBe(false);
	});

	test("plan.json stores chunk paths relative to its folder", () => {
		const repo = fixtureRepo();
		const diff = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		const plan = JSON.parse(readFileSync(diff.diffPath.replace(/\.diff$/, ".plan.json"), "utf8"));
		expect(plan.contextPath).toBe(basename(diff.contextPath));
		expect(plan.chunks[0].findingsPath).toBe(basename(diff.chunks[0].findingsPath));
		expect(plan.chunks[0].annotatedPath).toBe(basename(diff.chunks[0].annotatedPath));
	});

	test("a copied scratch folder compiles from its own findings, not the original's", () => {
		const repo = fixtureRepo();
		const diff = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		findingsFile(diff, [{ path: "src/a.ts", line: 3, tier: "high", body: "Original finding." }]);
		const copy = cliFixtures.tmp(createdDirs, "thrash-copy-");
		cpSync(dirname(diff.diffPath), copy, { recursive: true });
		const copiedDiff = join(copy, basename(diff.diffPath));
		writeFileSync(
			join(copy, basename(diff.chunks[0].findingsPath)),
			`\`\`\`json\n${JSON.stringify({ changed: "Adds a.", strengths: [], opportunities: [], findings: [{ path: "src/a.ts", line: 3, tier: "low", body: "Copied finding." }] })}\n\`\`\`\n`,
		);
		const result = run(["compile", ".", "--diff", copiedDiff, "--json"], { cwd: repo });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const review = JSON.parse(readFileSync(JSON.parse(result.stdout).reviewPath, "utf8")).review;
		const text = JSON.stringify(review);
		expect(text).toContain("Copied finding.");
		expect(text).not.toContain("Original finding.");
	});

	for (const [label, stored, message] of [
		["an absolute path outside the folder", "/etc/passwd", "run thrash diff again"],
		["a parent-relative path", "../elsewhere.findings.md", "escapes the plan folder"],
	] as const) {
		test(`compile refuses a plan with ${label}`, () => {
			const repo = fixtureRepo();
			const diff = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
			findingsFile(diff, []);
			const planPath = diff.diffPath.replace(/\.diff$/, ".plan.json");
			const plan = JSON.parse(readFileSync(planPath, "utf8"));
			plan.chunks[0].findingsPath = stored;
			writeFileSync(planPath, JSON.stringify(plan));
			const result = run(["compile", ".", "--diff", diff.diffPath], { cwd: repo });
			expect(result.exitCode).toBe(EXIT.ERR);
			expect(result.stderr).toContain(message);
		});
	}

	test("compile still reads an older plan whose absolute paths sit inside its folder", () => {
		const repo = fixtureRepo();
		const diff = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		findingsFile(diff, [{ path: "src/a.ts", line: 3, tier: "low", body: "Legacy plan finding." }]);
		const planPath = diff.diffPath.replace(/\.diff$/, ".plan.json");
		const plan = JSON.parse(readFileSync(planPath, "utf8"));
		plan.chunks[0].findingsPath = diff.chunks[0].findingsPath;
		writeFileSync(planPath, JSON.stringify(plan));
		const result = run(["compile", ".", "--diff", diff.diffPath, "--json"], { cwd: repo });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(readFileSync(JSON.parse(result.stdout).reviewPath, "utf8")).toContain("Legacy plan finding.");
	});

	test("compile . writes an /address-compatible file and prints the preview", () => {
		const repo = fixtureRepo();
		const diff = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		findingsFile(diff, [
			{
				path: "src/a.ts",
				line: 3,
				tier: "high",
				body: "`c` is never exported.",
			},
			{
				path: "src/a.ts",
				line: 1,
				tier: "nit",
				body: "Prefer `let`? No, keep `const`.",
			},
		]);
		const result = run(
			["compile", ".", "--diff", diff.diffPath, "--spice", "1"],
			{
				cwd: repo,
			},
		);
		expect(result.exitCode).toBe(EXIT.OK);
		expect(result.stdout).toContain("Verdict: APPROVE");
		expect(result.stdout).toContain("VERDICT=approve");
		const addressFile = /ADDRESS_FILE=(.+)/.exec(result.stdout)?.[1];
		expect(addressFile && existsSync(addressFile)).toBe(true);
		expect(readdirSync(join(repo, ".agents", "code-review"))).toHaveLength(1);
		const body = readFileSync(addressFile as string, "utf8");
		expect(body).toContain("## src/a.ts:3\n\nseverity: high");
		expect(body).not.toContain("Prefer `let`");
		expect(dirname(addressFile as string)).toBe(
			join(repo, ".agents", "code-review"),
		);
		expect(addressFile).toMatch(/\/\d{4}-\d{2}-\d{2}-\d{6}-\d{3}\.md$/);
		// Local ingestion belongs to the packaged host workflow; address has no --local CLI verb.
		const workflow = readFileSync(ADDRESS_WORKFLOW, "utf8");
		expect(workflow).toContain(
			"<reviewDir>/.agents/code-review/YYYY-MM-DD-HHMMSS-NNN.md",
		);
		expect(workflow).toContain('source:"local-review"');
		expect(workflow).toContain("path, line, body, severity|null, reviewFile");
	});

	test("post refuses a local target", () => {
		const repo = fixtureRepo();
		const result = run(["post", ".", "--review", "/nonexistent.json"], {
			cwd: repo,
		});
		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.stderr).toContain("post needs a PR or MR URL");
	});
});

describe("remote mode via the GitHub adapter", () => {
	test("published review comments round-trip through address gather and resolve", () => {
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"pr diff 12"*)
    cat "$FAKE_DIFF"
    exit 0
    ;;
  *"resolveReviewThread"*)
    printf '%s' '${EMPTY_THREADS}' > "$FAKE_THREADS"
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"thread-posted-1"}}}}'
    exit 0
    ;;
  *"api graphql"*)
    cat "$FAKE_THREADS"
    exit 0
    ;;
  *"pr view 12"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *"pulls/12/reviews"*)
    cat > "$FAKE_STDIN_CAPTURE"
    echo '{"html_url":"${PR_URL}#pullrequestreview-1"}'
    exit 0
    ;;`),
		);
		const diffFixture = join(createdDirs[0], "pr.diff");
		writeFileSync(diffFixture, GH_DIFF);
		const threadsFixture = join(createdDirs[0], "threads.json");
		writeFileSync(threadsFixture, EMPTY_THREADS);
		const env = {
			GH_BIN: gh.bin,
			AI_VCS_PROVIDER: "github",
			FAKE_CALL_LOG: gh.log,
			FAKE_DIFF: diffFixture,
			FAKE_STDIN_CAPTURE: gh.stdin,
			FAKE_THREADS: threadsFixture,
		};
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");

		const diff = run(["diff", PR_URL], { cwd, env });
		expect(diff.exitCode).toBe(EXIT.OK);
		const diffOut = JSON.parse(diff.stdout);
		expect(diffOut).toMatchObject({
			mode: "remote",
			provider: "github",
			untracked: [],
		});
		expect(diffOut.stats).toMatchObject({ files: 1, added: 2, deleted: 1 });
		expect(cliFixtures.readCalls(gh.log)[0]).toBe(
			"pr diff 12 -R acme/widgets --color never",
		);

		findingsFile(diffOut, [
			{
				path: "src/a.ts",
				line: 2,
				tier: "critical",
				body: "Changing `b` breaks the exported contract.",
			},
			{
				path: "src/a.ts",
				line: 2,
				side: "old",
				tier: "low",
				body: "Removed without a changelog note.",
			},
		]);
		const compile = run(
			["compile", PR_URL, "--diff", diffOut.diffPath, "--json"],
			{
				cwd,
				env,
			},
		);
		expect(compile.exitCode).toBe(EXIT.OK);
		const compiled = JSON.parse(compile.stdout);
		expect(compiled.verdict).toBe("request_changes");
		expect(compiled.addressFile).toBeUndefined();

		const post = run(["post", PR_URL, "--review", compiled.reviewPath], {
			cwd,
			env,
		});
		expect(post.exitCode, post.stderr).toBe(EXIT.OK);
		expect(JSON.parse(post.stdout)).toMatchObject({
			verdict: "request_changes",
			degraded: false,
			commentCount: 2,
		});
		const payload = JSON.parse(readFileSync(gh.stdin, "utf8"));
		expect(payload.event).toBe("REQUEST_CHANGES");
		expect(payload.commit_id).toBe("abc123");
		expect(payload.comments).toEqual([
			{
				path: "src/a.ts",
				line: 2,
				side: "RIGHT",
				body: expect.stringContaining("**Critical**"),
			},
			{
				path: "src/a.ts",
				line: 2,
				side: "LEFT",
				body: expect.stringContaining("**Low**"),
			},
		]);
		expect(payload.body).toContain(
			"**Verdict:** Request changes. 1 critical finding found.",
		);

		// The fake provider exposes the exact body sent by thrash, as a persisted review thread.
		writeFileSync(
			threadsFixture,
			JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: [
									{
										id: "thread-posted-1",
										isResolved: false,
										path: payload.comments[0].path,
										line: payload.comments[0].line,
										comments: {
											nodes: [
												{
													databaseId: 7001,
													author: { login: "test-reviewer" },
													body: payload.comments[0].body,
													createdAt: "2026-02-01T00:00:00Z",
													diffHunk: GH_DIFF,
												},
											],
										},
									},
								],
								pageInfo: { hasNextPage: false },
							},
						},
					},
				},
			}),
		);
		const gather = run(["gather-unresolved", "12"], {
			cwd,
			env,
			command: "address",
		});
		expect(gather.exitCode).toBe(EXIT.OK);
		const items = JSON.parse(gather.stdout);
		expect(items).toEqual([
			{
				threadId: "thread-posted-1",
				commentId: 7001,
				path: payload.comments[0].path,
				line: payload.comments[0].line,
				body: payload.comments[0].body,
				diffHunk: GH_DIFF,
				author: "test-reviewer",
				mode: "fix",
			},
		]);
		const resolved = run(["resolve", items[0].threadId, "--pr=12"], {
			cwd,
			env,
			command: "address",
		});
		expect(resolved.exitCode).toBe(EXIT.OK);
		expect(
			cliFixtures
				.readCalls(gh.log)
				.some(
					(call) =>
						call.includes("resolveReviewThread") &&
						call.includes("threadId=thread-posted-1"),
				),
		).toBe(true);
		const after = run(["gather-unresolved", "12"], {
			cwd,
			env,
			command: "address",
		});
		expect(after.exitCode).toBe(EXIT.OK);
		expect(JSON.parse(after.stdout)).toEqual([]);

		const tally = run(["tally", compiled.reviewPath], { cwd, env });
		expect(tally.exitCode).toBe(EXIT.OK);
		expect(tally.stdout).toContain(
			`| #12 | [review](${PR_URL}#pullrequestreview-1) | 1 | 0 | 0 | 1 | 0 | 2 | Request changes |`,
		);
	});

	test("stack lists the whole open stack from any PR in it, root first", () => {
		const pulls = [
			{
				number: 13,
				title: "two",
				html_url: "u13",
				state: "open",
				head: { ref: "b" },
				base: { ref: "a" },
			},
			{
				number: 12,
				title: "one",
				html_url: "u12",
				state: "open",
				head: { ref: "a" },
				base: { ref: "main" },
			},
			{
				number: 50,
				title: "solo",
				html_url: "u50",
				state: "open",
				head: { ref: "z" },
				base: { ref: "main" },
			},
		];
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"pulls --method GET"*)
    echo '${JSON.stringify(pulls)}'
    exit 0
    ;;`),
		);
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
		const result = run(["stack", "https://github.com/acme/widgets/pull/13"], {
			cwd,
			env: { GH_BIN: gh.bin, FAKE_CALL_LOG: gh.log },
		});
		expect(result.exitCode).toBe(EXIT.OK);
		expect(JSON.parse(result.stdout)).toEqual([
			{
				number: 12,
				title: "one",
				url: "u12",
				headRefName: "a",
				baseRefName: "main",
				state: "open",
			},
			{
				number: 13,
				title: "two",
				url: "u13",
				headRefName: "b",
				baseRefName: "a",
				state: "open",
			},
		]);
	});

	test("stack --diff writes every diff and prints one compact row per PR", () => {
		const pulls = [
			{
				number: 12,
				title: "one",
				html_url: `${PR_URL}`,
				state: "open",
				head: { ref: "a" },
				base: { ref: "main" },
			},
			{
				number: 13,
				title: "two",
				html_url: `${PR_URL.replace("12", "13")}`,
				state: "open",
				head: { ref: "b" },
				base: { ref: "a" },
			},
		];
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"pulls --method GET"*)
    echo '${JSON.stringify(pulls)}'
    exit 0
    ;;
  *"pr diff"*)
    cat "$FAKE_DIFF"
    exit 0
    ;;`),
		);
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
		const diffFixture = join(cwd, "pr.diff");
		writeFileSync(diffFixture, GH_DIFF);
		const result = run(["stack", PR_URL, "--diff"], {
			cwd,
			env: { GH_BIN: gh.bin, FAKE_CALL_LOG: gh.log, FAKE_DIFF: diffFixture },
		});
		expect(result.exitCode).toBe(EXIT.OK);
		const rows = JSON.parse(result.stdout);
		expect(rows.map((r: { number: number }) => r.number)).toEqual([12, 13]);
		expect(rows[1]).toMatchObject({ changed: 3, skipped: 0 });
		expect(rows[1].chunks[0].findingsPath).toEndWith("-13.chunk1.findings.md");
		expect(readFileSync(rows[1].chunks[0].annotatedPath, "utf8")).toContain(
			"const c = 4;",
		);
	});

	test("stack --diff reviews only open PRs, keeps merged ones as context and reports closed ones", () => {
		const url = (n: number) => PR_URL.replace("12", String(n));
		const pr = (number: number, title: string, state: string, merged: boolean, head: string, base: string) => ({
			number, title, html_url: url(number), state, merged_at: merged ? "2026-10-01T00:00:00Z" : null,
			head: { ref: head }, base: { ref: base },
		});
		const open = [pr(12, "one", "open", false, "a", "x"), pr(14, "three", "open", false, "c", "b")];
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"pulls --method GET"*"state=open"*)
    echo '${JSON.stringify(open)}'
    ;;
  *"pulls --method GET"*"head=acme:b"*)
    echo '${JSON.stringify([pr(13, "two", "closed", true, "b", "a"), pr(9, "old", "closed", true, "b2", "a")])}'
    ;;
  *"pulls --method GET"*"head=acme:x"*)
    echo '${JSON.stringify([pr(11, "dropped", "closed", false, "x", "main")])}'
    ;;
  *"pulls --method GET"*)
    echo '[]'
    ;;
  *"pr diff"*)
    cat "$FAKE_DIFF"
    ;;`),
		);
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
		const diffFixture = join(cwd, "pr.diff");
		writeFileSync(diffFixture, GH_DIFF);
		const env = { GH_BIN: gh.bin, FAKE_CALL_LOG: gh.log, FAKE_DIFF: diffFixture };
		const result = run(["stack", url(14), "--diff"], { cwd, env });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const rows = JSON.parse(result.stdout);
		expect(rows.map((r: { number: number; state: string; reviewed: boolean }) => [r.number, r.state, r.reviewed])).toEqual([
			[11, "closed", false],
			[12, "open", true],
			[13, "merged", false],
			[14, "open", true],
		]);
		expect(rows[0].diffPath).toBeUndefined();
		expect(rows[2].chunks).toBeUndefined();
		const calls = cliFixtures.readCalls(gh.log);
		expect(calls.filter((call) => call.startsWith("pr diff")).map((call) => call.split(" ")[2]).sort()).toEqual(["12", "14"]);
		expect(calls.some((call) => call.includes("state=all"))).toBe(true);
		expect(calls.filter((call) => call.includes("pulls --method GET") && !call.includes("head=")).every((call) => call.includes("state=open"))).toBe(true);
		const context = readFileSync(rows[3].contextPath, "utf8");
		expect(context).toContain("## Merged earlier in this stack (context only, not reviewed)");
		expect(context).toContain(`- #13 two (${url(13)}), b into a`);
		expect(context).not.toContain("#11");
		expect(JSON.parse(readFileSync(rows[2].statusPath, "utf8"))).toEqual({ target: url(13), stackState: "merged" });
		const tally = run(["tally", rows[0].statusPath, rows[2].statusPath], { cwd, env });
		expect(tally.exitCode, tally.stderr).toBe(EXIT.OK);
		expect(tally.stdout).toContain("| #13 |");
		expect(tally.stdout).toContain("merged (context only, not reviewed)");
		expect(tally.stdout).toContain("| #11 |");
		expect(tally.stdout).toContain("closed without merging (not reviewed)");
	});

	test("stack never climbs past the default branch into a merged release PR", () => {
		const url = (n: number) => PR_URL.replace("12", String(n));
		const open = [{ number: 12, title: "one", html_url: url(12), state: "open", merged_at: null, head: { ref: "a" }, base: { ref: "main" } }];
		const release = [{ number: 5, title: "release", html_url: url(5), state: "closed", merged_at: "2026-09-01T00:00:00Z", head: { ref: "main" }, base: { ref: "production" } }];
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"repo view"*)
    echo '{"owner":{"login":"acme"},"name":"widgets","defaultBranchRef":{"name":"main"},"url":"https://github.com/acme/widgets"}'
    ;;
  *"pulls --method GET"*"state=open"*)
    echo '${JSON.stringify(open)}'
    ;;
  *"pulls --method GET"*"head=acme:main"*)
    echo '${JSON.stringify(release)}'
    ;;
  *"pulls --method GET"*)
    echo '[]'
    ;;`),
		);
		const result = run(["stack", url(12)], { env: { GH_BIN: gh.bin, FAKE_CALL_LOG: gh.log } });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(JSON.parse(result.stdout).map((r: { number: number }) => r.number)).toEqual([12]);
		expect(cliFixtures.readCalls(gh.log).some((call) => call.includes("head=acme:main"))).toBe(false);
	});

	test("stack from a merged PR fetches it and walks down to the open child", () => {
		const url = (n: number) => PR_URL.replace("12", String(n));
		const merged = { number: 13, title: "two", url: url(13), state: "MERGED", headRefName: "b", baseRefName: "main", body: "", mergedAt: "2026-10-01T00:00:00Z" };
		const child = { number: 14, title: "three", html_url: url(14), state: "open", merged_at: null, head: { ref: "c" }, base: { ref: "b" } };
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"pulls --method GET"*"state=open"*)
    echo '${JSON.stringify([child])}'
    ;;
  *"pr view 13"*)
    echo '${JSON.stringify(merged)}'
    ;;
  *"pulls --method GET"*)
    echo '[]'
    ;;`),
		);
		const result = run(["stack", url(13)], { env: { GH_BIN: gh.bin, FAKE_CALL_LOG: gh.log } });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(JSON.parse(result.stdout).map((r: { number: number; state: string }) => [r.number, r.state])).toEqual([
			[13, "merged"],
			[14, "open"],
		]);
	});

	test("stack --diff with no merged member leaves the context file without a merged section", () => {
		const pulls = [
			{ number: 12, title: "one", html_url: PR_URL, state: "open", merged_at: null, head: { ref: "a" }, base: { ref: "main" } },
		];
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"pulls --method GET"*)
    echo '${JSON.stringify(pulls)}'
    exit 0
    ;;
  *"pr diff"*)
    cat "$FAKE_DIFF"
    exit 0
    ;;`),
		);
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
		const diffFixture = join(cwd, "pr.diff");
		writeFileSync(diffFixture, GH_DIFF);
		const result = run(["stack", PR_URL, "--diff"], {
			cwd,
			env: { GH_BIN: gh.bin, FAKE_CALL_LOG: gh.log, FAKE_DIFF: diffFixture },
		});
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const rows = JSON.parse(result.stdout);
		expect(readFileSync(rows[0].contextPath, "utf8")).not.toContain("Merged earlier");
	});

	test("post rejects a review compiled for a different target", () => {
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
		const review = join(cwd, "review.json");
		writeFileSync(review, JSON.stringify({ target: ".", review: {} }));
		const result = run(["post", PR_URL, "--review", review], { cwd });
		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.stderr).toContain("compiled for .");
	});
});

describe("remote mode via the GitLab adapter", () => {
	test("post retains context-line positions and reports a refused approval in JSON and tally", () => {
		const url = "https://gitlab.com/acme/widgets/-/merge_requests/12";
		const dir = cliFixtures.tmp(createdDirs, "thrash-fake-glab-");
		const diffPath = join(dir, "mr.diff");
		const draftPath = join(dir, "draft.json");
		const publishPath = join(dir, "publish.json");
		const log = join(dir, "calls.log");
		writeFileSync(diffPath, GH_DIFF);
		writeFakeCli(
			dir,
			"glab",
			cliFixtures.shScript(`
  *"mr diff 12"*)
    cat "$FAKE_DIFF"
    ;;
  *"mr view 12"*)
    echo '${JSON.stringify(cliFixtures.glMr(12, "feature"))}'
    ;;
  *"/discussions"*)
    echo '[]'
    ;;
  *"/draft_notes/bulk_publish"*)
    cat > "$FAKE_PUBLISH"
    echo '{}'
    ;;
  *"/draft_notes"*)
    cat > "$FAKE_DRAFT"
    echo '{"id":701}'
    ;;
  *"/approve"*)
    echo 'approval forbidden for this reviewer' >&2
    exit 1
    ;;
  *"api projects/acme%2Fwidgets/merge_requests/12"*)
    echo '${JSON.stringify({ web_url: url, diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" } })}'
    ;;`),
		);
		const env = {
			GLAB_BIN: join(dir, "glab"),
			FAKE_CALL_LOG: log,
			FAKE_DIFF: diffPath,
			FAKE_DRAFT: draftPath,
			FAKE_PUBLISH: publishPath,
		};
		const cwd = cliFixtures.tmp(createdDirs, "thrash-gitlab-cwd-");
		const diffResult = run(["diff", url], { cwd, env });
		expect(diffResult.exitCode).toBe(EXIT.OK);
		const diff = JSON.parse(diffResult.stdout);
		expect(diff).toMatchObject({
			mode: "remote",
			provider: "gitlab",
			untracked: [],
		});
		expect(readFileSync(diff.contextPath, "utf8")).toContain("Title: MR !12");
		findingsFile(diff, [
			{
				path: "src/a.ts",
				line: 4,
				tier: "medium",
				body: "Cover the public contract.",
			},
		]);
		const compile = run(["compile", url, "--diff", diff.diffPath, "--json"], {
			cwd,
			env,
		});
		expect(compile.exitCode).toBe(EXIT.OK);
		const compiled = JSON.parse(compile.stdout);
		expect(compiled.verdict).toBe("approve");
		expect(compiled.addressFile).toBeUndefined();
		const post = run(["post", url, "--review", compiled.reviewPath], {
			cwd,
			env,
		});
		expect(post.exitCode, post.stderr).toBe(EXIT.OK);
		expect(JSON.parse(post.stdout)).toEqual({
			url,
			verdict: "comment",
			degraded: true,
			commentCount: 1,
			requestedVerdict: "approve",
		});
		expect(JSON.parse(readFileSync(draftPath, "utf8"))).toEqual({
			note: expect.stringContaining("**Medium** Cover the public contract."),
			position: {
				position_type: "text",
				base_sha: "base",
				start_sha: "start",
				head_sha: "head",
				old_path: "src/a.ts",
				new_path: "src/a.ts",
				old_line: 3,
				new_line: 4,
			},
		});
		expect(JSON.parse(readFileSync(publishPath, "utf8"))).toMatchObject({
			reviewer_state: "reviewed",
			note: expect.stringContaining("**Verdict:** Approve."),
		});
		const calls = cliFixtures.readCalls(log);
		expect(calls[0]).toBe("mr diff 12 --raw -R acme/widgets");
		const draftIndex = calls.findIndex((call) =>
			call.includes("/draft_notes -X POST"),
		);
		const publishIndex = calls.findIndex((call) =>
			call.includes("/draft_notes/bulk_publish"),
		);
		const approveIndex = calls.findIndex((call) =>
			call.includes("/approve -X POST"),
		);
		expect(draftIndex).toBeGreaterThan(-1);
		expect(publishIndex).toBeGreaterThan(draftIndex);
		expect(approveIndex).toBeGreaterThan(publishIndex);
		const tally = run(["tally", compiled.reviewPath], { cwd, env });
		expect(tally.exitCode).toBe(EXIT.OK);
		expect(tally.stdout).toContain("Comment (approve refused)");
		expect(tally.stdout).toContain(`[review](${url})`);
	});
});

describe("stack via the GitLab adapter", () => {
	test("asks per base branch for merged and closed MRs and marks them", () => {
		const url = "https://gitlab.com/acme/widgets/-/merge_requests/23";
		const dir = cliFixtures.tmp(createdDirs, "thrash-stack-glab-");
		const open = [cliFixtures.glMr(21, "a", { target_branch: "x" }), cliFixtures.glMr(23, "c", { target_branch: "b" })];
		writeFakeCli(
			dir,
			"glab",
			cliFixtures.shScript(`
  *"mr list"*"--source-branch b"*)
    echo '${JSON.stringify([cliFixtures.glMr(22, "b", { target_branch: "a", state: "merged", merged_at: "2026-10-01T00:00:00Z" })])}'
    ;;
  *"mr list"*"--source-branch x"*)
    echo '${JSON.stringify([cliFixtures.glMr(20, "x", { state: "closed" })])}'
    ;;
  *"mr list"*"--all"*)
    echo '[]'
    ;;
  *"mr list"*)
    echo '${JSON.stringify(open)}'
    ;;`),
		);
		const log = join(dir, "calls.log");
		const result = run(["stack", url], { env: { GLAB_BIN: join(dir, "glab"), FAKE_CALL_LOG: log } });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(JSON.parse(result.stdout).map((r: { number: number; state: string }) => [r.number, r.state])).toEqual([
			[20, "closed"],
			[21, "open"],
			[22, "merged"],
			[23, "open"],
		]);
		const calls = cliFixtures.readCalls(log);
		expect(calls.some((call) => call.includes("--all") && call.includes("--source-branch b"))).toBe(true);
	});
});

describe("post --dry-run", () => {
	const url = "https://gitlab.com/acme/widgets/-/merge_requests/12";

	function compiledGitlabReview(): { env: Record<string, string>; cwd: string; reviewPath: string; log: string } {
		const dir = cliFixtures.tmp(createdDirs, "thrash-dry-glab-");
		const diffPath = join(dir, "mr.diff");
		const log = join(dir, "calls.log");
		writeFileSync(diffPath, GH_DIFF);
		writeFakeCli(
			dir,
			"glab",
			cliFixtures.shScript(`
  *"mr diff 12"*)
    cat "$FAKE_DIFF"
    ;;
  *"mr view 12"*)
    echo '${JSON.stringify(cliFixtures.glMr(12, "feature"))}'
    ;;
  *"/discussions"*)
    echo '[]'
    ;;
  *"api projects/acme%2Fwidgets/merge_requests/12"*)
    echo '${JSON.stringify({ web_url: url, diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" } })}'
    ;;
  *)
    echo "unexpected write" >&2
    exit 9
    ;;`),
		);
		const env = { GLAB_BIN: join(dir, "glab"), FAKE_CALL_LOG: log, FAKE_DIFF: diffPath };
		const cwd = cliFixtures.tmp(createdDirs, "thrash-dry-cwd-");
		const diff = JSON.parse(run(["diff", url], { cwd, env }).stdout);
		findingsFile(diff, [{ path: "src/a.ts", line: 4, tier: "medium", body: "Cover the public contract." }]);
		const compiled = JSON.parse(run(["compile", url, "--diff", diff.diffPath, "--json"], { cwd, env }).stdout);
		return { env, cwd, reviewPath: compiled.reviewPath, log };
	}

	function assertNoProviderCall(log: string, before: number): void {
		expect(cliFixtures.readCalls(log).slice(before)).toEqual([]);
	}

	test("--dry-run prints the review it would post and calls no provider", () => {
		const { env, cwd, reviewPath, log } = compiledGitlabReview();
		const before = cliFixtures.readCalls(log).length;
		const post = run(["post", url, "--review", reviewPath, "--dry-run"], { cwd, env });
		expect(post.exitCode, post.stderr).toBe(EXIT.OK);
		const out = JSON.parse(post.stdout);
		expect(out).toMatchObject({ dryRun: true, url, requestedVerdict: "approve" });
		expect(out.review.comments).toHaveLength(1);
		expect(JSON.stringify(out.review)).toContain("Cover the public contract.");
		assertNoProviderCall(log, before);
		expect(existsSync(reviewPath.replace(/\.review\.json$/, ".posted.json"))).toBe(false);
	});

	for (const value of ["1", "true", "YES", " 1 "]) {
		test(`DG_THRASH_DRY_RUN=${JSON.stringify(value)} makes post a no-op without the flag`, () => {
			const { env, cwd, reviewPath, log } = compiledGitlabReview();
			const before = cliFixtures.readCalls(log).length;
			const post = run(["post", url, "--review", reviewPath], {
				cwd,
				env: { ...env, DG_THRASH_DRY_RUN: value },
			});
			expect(post.exitCode, post.stderr).toBe(EXIT.OK);
			expect(JSON.parse(post.stdout).dryRun).toBe(true);
			assertNoProviderCall(log, before);
		});
	}

	test("DG_THRASH_DRY_RUN=0 still posts", () => {
		const { env, cwd, reviewPath, log } = compiledGitlabReview();
		const before = cliFixtures.readCalls(log).length;
		const post = run(["post", url, "--review", reviewPath], {
			cwd,
			env: { ...env, DG_THRASH_DRY_RUN: "0" },
		});
		expect(post.stdout).not.toContain('"dryRun"');
		expect(
			cliFixtures.readCalls(log).slice(before).some((call) => call.includes("/draft_notes")),
		).toBe(true);
	});

	test("--dry-run still refuses a local target and a mismatched review", () => {
		const repo = fixtureRepo();
		const local = run(["post", ".", "--review", "/nonexistent.json", "--dry-run"], { cwd: repo });
		expect(local.exitCode).toBe(EXIT.ERR);
		expect(local.stderr).toContain("post needs a PR or MR URL");
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
		const review = join(cwd, "review.json");
		writeFileSync(review, JSON.stringify({ target: ".", review: {} }));
		const mismatch = run(["post", url, "--review", review, "--dry-run"], { cwd });
		expect(mismatch.exitCode).toBe(EXIT.ERR);
		expect(mismatch.stderr).toContain("compiled for .");
	});
});

describe("thrash command dispatch", () => {
	test("no verb prints usage on stdout and returns status 2", () => {
		const result = run([]);
		expect(result.exitCode).toBe(EXIT.USAGE);
		expect(result.stdout).toContain("Usage: thrash <subcommand> [options]");
		expect(result.stderr).toBe("");
	});

	test("unknown verbs print usage on stderr and return status 2", () => {
		const result = run(["no-such-verb"]);
		expect(result.exitCode).toBe(EXIT.USAGE);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("unknown subcommand 'no-such-verb'");
	});

	test.each(["--help", "-h"])(
		"%s lists the five helper verbs without provider calls",
		(flag) => {
			const result = run([flag]);
			expect(result.exitCode).toBe(EXIT.OK);
			expect(result.stderr).toBe("");
			for (const verb of ["diff", "compile", "post", "stack", "tally"]) {
				expect(result.stdout).toMatch(new RegExp(`^  ${verb} `, "m"));
			}
		},
	);

	test.each(["diff", "compile", "post", "stack"])(
		"%s without a target returns status 1",
		(verb) => {
			const result = run([verb]);
			expect(result.exitCode).toBe(EXIT.ERR);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(`${verb} requires a target`);
		},
	);

	test("tally without review files returns status 1", () => {
		const result = run(["tally"]);
		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(
			"tally requires one or more review JSON files",
		);
	});

	test("stack refuses local targets", () => {
		const result = run(["stack", "."], { cwd: fixtureRepo() });
		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("stack needs a PR or MR URL");
	});

	test.each([
		{ flags: ["--spice"], message: "--spice requires a value" },
		{ flags: ["--spice", "0"], message: "--spice" },
		{ flags: ["--min-tier", "blocker"], message: "unknown tier" },
	])(
		"compile rejects invalid flags $flags without publishing an artifact",
		({ flags, message }) => {
			const repo = fixtureRepo();
			const diffResult = run(["diff", "."], { cwd: repo });
			expect(diffResult.exitCode).toBe(EXIT.OK);
			const diff = JSON.parse(diffResult.stdout);
			findingsFile(diff, []);
			const result = run(["compile", ".", "--diff", diff.diffPath, ...flags], {
				cwd: repo,
			});
			expect(result.exitCode).toBe(EXIT.ERR);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(message);
			expect(existsSync(join(repo, ".agents", "code-review"))).toBe(false);
		},
	);
});

describe("compiled thrash workflow", () => {
	let installation: ReturnType<typeof proxyFixtures>;
	let fixture: ReturnType<typeof proxyFixtures>;
	let binary: string;
	let skills: string;

	beforeAll(() => {
		installation = proxyFixtures();
		const original = compileProxyCli(installation);
		const moved = join(installation.root, "relocated binary ' directory");
		mkdirSync(moved);
		binary = join(moved, "dg skills");
		renameSync(original, binary);
		const staging = installation.tmp("thrash skill staging ");
		for (const name of ["thrash", "address", "proxy"]) {
			cpSync(
				join(import.meta.dir, "../../../plugins/dg/skills", name),
				join(staging, name),
				{ recursive: true },
			);
		}
		skills = join(installation.root, "relocated plugin ' skills");
		renameSync(staging, skills);
	}, 30000);
	afterAll(() => installation?.cleanup());
	beforeEach(() => {
		fixture = proxyFixtures();
		for (const name of ["git", "cat"]) {
			const executable = Bun.which(name);
			if (!executable) throw new Error(`Test requires ${name}`);
			symlinkSync(executable, join(fixture.bin, name));
		}
		const bin = join(fixture.home, ".dg", "bin");
		mkdirSync(bin, { recursive: true });
		symlinkSync(binary, join(bin, "dg-skills"));
	});
	afterEach(() => fixture?.cleanup());

	function execute(
		args: string[],
		options: { cwd?: string; env?: Record<string, string> } = {},
	): RunResult {
		const proc = Bun.spawnSync([binary, ...args], {
			cwd: options.cwd ?? fixture.root,
			env: fixture.env({ DG_SKILLS_DIR: skills, ...options.env }),
		});
		return {
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
			exitCode: proc.exitCode,
		};
	}

	test("relocated instructions bootstrap local diff and preserve the address handoff from an external cwd", () => {
		const repo = fixtureRepo();
		const skill = readFileSync(join(skills, "thrash", "SKILL.md"), "utf8");
		const bootstrap = skill.match(/```bash\n(DG=[\s\S]*?)\n```/)?.[1];
		expect(bootstrap).toBeDefined();
		const proc = Bun.spawnSync(
			["sh", "-c", `${bootstrap}\n"$DG" thrash diff "$TARGET"`],
			{
				cwd: fixture.root,
				env: fixture.env({ TARGET: repo, DG_SKILLS_DIR: skills }),
			},
		);
		expect(proc.exitCode, proc.stderr.toString()).toBe(EXIT.OK);
		const diff = JSON.parse(proc.stdout.toString());
		expect(diff.stats).toMatchObject({ files: 1, added: 2, deleted: 1 });
		expect(readFileSync(diff.chunks[0].annotatedPath, "utf8")).toContain(
			"const c = 4;",
		);
		findingsFile(diff, [
			{
				path: "src/a.ts",
				line: 3,
				tier: "high",
				body: "Export the new value.",
			},
		]);
		const compiled = execute([
			"thrash",
			"compile",
			repo,
			"--diff",
			diff.diffPath,
			"--json",
		]);
		expect(compiled.exitCode, compiled.stderr).toBe(EXIT.OK);
		const output = JSON.parse(compiled.stdout);
		expect(dirname(output.addressFile)).toBe(
			join(repo, ".agents", "code-review"),
		);
		expect(readFileSync(output.addressFile, "utf8")).toContain(
			"## src/a.ts:3\n\nseverity: high",
		);
		const workflow = readFileSync(
			join(skills, "address", "references", "workflow.md"),
			"utf8",
		);
		expect(workflow).toContain(
			"<reviewDir>/.agents/code-review/YYYY-MM-DD-HHMMSS-NNN.md",
		);
		expect(skill).toContain("report `ADDRESS_FILE=` and offer `/address -l`");
		for (const legacy of ["thrash-helper", "proxy-helper", "address-helper"]) {
			expect(Bun.which(legacy, { PATH: fixture.bin })).toBeNull();
		}
	});

	test("relocated binary fetches a fake-provider stack, publishes one review, and tallies the persisted post", () => {
		const pulls = [
			cliFixtures.restPr(12, "a"),
			cliFixtures.restPr(13, "b", { base: { ref: "a" } }),
		];
		const diffPath = join(fixture.root, "change.diff");
		const payloadPath = join(fixture.root, "posted.json");
		const log = join(fixture.root, "provider.log");
		writeFileSync(diffPath, GH_DIFF);
		writeFakeCli(
			fixture.bin,
			"gh",
			cliFixtures.shScript(`
  *"pulls --method GET"*) echo '${JSON.stringify(pulls)}' ;;
  *"pr diff"*) cat "$FAKE_DIFF" ;;
  *"pr view"*"--json headRefOid"*) echo '{"headRefOid":"head-fixture"}' ;;
  *"pr view"*) echo '${JSON.stringify({ number: 13, title: "Child change", url: PR_URL.replace("12", "13"), headRefName: "b", baseRefName: "a", body: "Synthetic change", state: "OPEN" })}' ;;
  *"api graphql"*) echo '${EMPTY_THREADS}' ;;
  *"pulls/13/reviews"*)
    cat > "$FAKE_PAYLOAD"
    echo '{"html_url":"${PR_URL.replace("12", "13")}#review-fixture"}'
    ;;`),
		);
		const env = {
			GH_BIN: join(fixture.bin, "gh"),
			FAKE_DIFF: diffPath,
			FAKE_PAYLOAD: payloadPath,
			FAKE_CALL_LOG: log,
		};
		const target = PR_URL.replace("12", "13");
		const stack = execute(["thrash", "stack", target, "--diff"], { env });
		expect(stack.exitCode, stack.stderr).toBe(EXIT.OK);
		const rows = JSON.parse(stack.stdout);
		expect(rows.map((row: { number: number }) => row.number)).toEqual([12, 13]);
		findingsFile(rows[1], [
			{
				path: "src/a.ts",
				line: 2,
				tier: "critical",
				body: "Preserve the public contract.",
			},
		]);
		const compile = execute(
			["thrash", "compile", target, "--diff", rows[1].diffPath, "--json"],
			{ env },
		);
		expect(compile.exitCode, compile.stderr).toBe(EXIT.OK);
		const review = JSON.parse(compile.stdout);
		const post = execute(
			["thrash", "post", target, "--review", review.reviewPath],
			{ env },
		);
		expect(post.exitCode, post.stderr).toBe(EXIT.OK);
		expect(JSON.parse(post.stdout)).toMatchObject({
			verdict: "request_changes",
			requestedVerdict: "request_changes",
			commentCount: 1,
		});
		expect(JSON.parse(readFileSync(payloadPath, "utf8"))).toMatchObject({
			event: "REQUEST_CHANGES",
			commit_id: "head-fixture",
		});
		const tally = execute(["thrash", "tally", review.reviewPath], { env });
		expect(tally.exitCode, tally.stderr).toBe(EXIT.OK);
		expect(tally.stdout).toContain(`[review](${target}#review-fixture)`);
		expect(tally.stdout).toContain("| Request changes |");
	});

	test("compiled proxy retries a malformed findings artifact in the same backend session and target cwd", () => {
		const repo = fixtureRepo();
		const diffResult = execute(["thrash", "diff", repo]);
		expect(diffResult.exitCode, diffResult.stderr).toBe(EXIT.OK);
		const diff = JSON.parse(diffResult.stdout);
		const reference = readFileSync(
			join(skills, "thrash", "references", "agent-prompt.md"),
			"utf8",
		);
		const template = reference.match(
			/```text\n(You are running inside \/thrash\.[\s\S]*?)\n```/,
		)?.[1];
		expect(template).toBeDefined();
		const prompt = template!
			.replace("<chunk annotatedPath>", diff.chunks[0].annotatedPath)
			.replace("<chunk findingsPath>", diff.chunks[0].findingsPath)
			.replace("<contextPath>", diff.contextPath)
			.replace("<id> of <chunk count>", "1 of 1")
			.replace("<1-5>", "2")
			.replace('<tier or "none">', "none")
			.replace("<URL or local path>", repo);
		const personas = join(fixture.root, "personas");
		mkdirSync(personas);
		writeFileSync(
			join(personas, "thrash.md"),
			"Review the supplied diff and write only the findings artifact.",
		);
		const sessionPath = join(fixture.root, "session.json");
		writeFakeCli(
			fixture.bin,
			"codex",
			`#!${BUN_BIN}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_PROXY_CALLS, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const resumed = args[1] === "resume";
const prompt = resumed ? args[3] : args[1];
const session = resumed ? JSON.parse(readFileSync(process.env.FAKE_SESSION, "utf8")) : {
  id: "thrash-fixture-session", cwd: process.cwd(), path: prompt.match(/^FINDINGS_PATH: (.+)$/m)?.[1]
};
if (!session.path || (resumed && (args[2] !== session.id || process.cwd() !== session.cwd))) process.exit(9);
writeFileSync(process.env.FAKE_SESSION, JSON.stringify(session));
const report = { changed: "Adds a public value.", strengths: [], opportunities: [], findings: [
  { path: "src/a.ts", line: 3, tier: "high", body: resumed ? "Export the new public value." : "" }
] };
writeFileSync(session.path, "\`\`\`json\\n" + JSON.stringify(report) + "\\n\`\`\`\\n");
console.log(JSON.stringify({ type: "thread.started", thread_id: session.id }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "WROTE " + session.path + " 1 findings" } }));
`,
		);
		const env = { DG_PERSONAS_DIR: personas, FAKE_SESSION: sessionPath };
		const first = execute(
			[
				"proxy",
				"codex",
				"--subagent",
				"thrash",
				"--cwd",
				repo,
				"--prompt",
				prompt,
			],
			{ env },
		);
		expect(first.exitCode, first.stderr).toBe(EXIT.OK);
		const result = JSON.parse(first.stdout);
		expect(result.message).toBe(
			`WROTE ${diff.chunks[0].findingsPath} 1 findings`,
		);
		const rejected = execute([
			"thrash",
			"compile",
			repo,
			"--diff",
			diff.diffPath,
			"--json",
		]);
		expect(rejected.exitCode).toBe(EXIT.ERR);
		expect(rejected.stderr).toContain("body is required");
		const retryPrompt =
			"Write the fenced json block to FINDINGS_PATH now, fixing: body is required. Reply with only the WROTE line.";
		const retry = execute(
			[
				"proxy",
				"codex",
				"--resume",
				result.sessionId,
				"--cwd",
				repo,
				"--prompt",
				retryPrompt,
			],
			{ env },
		);
		expect(retry.exitCode, retry.stderr).toBe(EXIT.OK);
		expect(JSON.parse(retry.stdout).sessionId).toBe(result.sessionId);
		const calls = fixture.readCalls();
		expect(calls).toHaveLength(2);
		expect(calls.map((call) => call.cwd)).toEqual([repo, repo]);
		expect(calls[0].args.join("\n")).toContain(
			"Review the supplied diff and write only the findings artifact.",
		);
		expect(calls[1].args).toEqual(
			BACKENDS.codex.buildArgs({
				prompt: retryPrompt,
				resume: result.sessionId,
			}),
		);
		expect(reference).toContain('--resume "<sessionId>" --cwd "<repo root>"');
		const compiled = execute([
			"thrash",
			"compile",
			repo,
			"--diff",
			diff.diffPath,
			"--json",
		]);
		expect(compiled.exitCode, compiled.stderr).toBe(EXIT.OK);
		expect(
			readFileSync(JSON.parse(compiled.stdout).addressFile, "utf8"),
		).toContain("Export the new public value.");
	});

	test("compiled proxy reports missing-backend installation guidance without invoking another available backend", () => {
		fixture.fakeBackend("pi");
		const result = execute([
			"proxy",
			"codex",
			"--prompt",
			"Review the supplied diff.",
		]);
		expect(result.exitCode).toBe(EXIT.ERR);
		const output = JSON.parse(result.stdout);
		expect(output).toMatchObject({
			backend: "codex",
			bin: BACKENDS.codex.bin,
			installCommand: BACKENDS.codex.install.command,
		});
		expect(output).not.toHaveProperty("missing");
		expect(fixture.readCalls()).toEqual([]);
		expect(existsSync(join(fixture.scratch, "proxy"))).toBe(false);
	});
});
