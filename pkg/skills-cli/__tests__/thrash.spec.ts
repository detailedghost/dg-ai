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
	chmodSync,
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
import { basename, dirname, isAbsolute, join } from "node:path";
import { shellCommand } from "@dg/common/node";
import { BACKENDS } from "../src/proxy";
import { THRASH_REVIEW_MARKER } from "../src/thrash/constants";
import { EXIT } from "../src/utils/legacy-command";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { makeTempDir } from "./git-repo-fixtures";
import { proxyFixtures, relocatedProxyCli } from "./proxy-fixtures";

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
	test("diff prefixes a non-ancestor base warning with thrash", () => {
		const repo = fixtureRepo();
		cliFixtures.runGit(["checkout", "-q", "main"], repo);
		cliFixtures.commitFile(repo, "other.txt", "other\n", "chore: main moves");
		cliFixtures.runGit(["checkout", "-q", "feature"], repo);
		const result = run(["diff", "--base", "main", "."], { cwd: repo });
		expect(result.exitCode).toBe(EXIT.OK);
		expect(result.stderr).toContain("thrash: warning: --base main");
		expect(result.stderr).not.toContain("meaningful:");
	});

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
		expect(out.repo).toMatchObject({ root: repo, source: "cwd" });
		expect(readFileSync(out.chunks[0].annotatedPath, "utf8")).toContain(
			"old:- new:2 + const b = 3;",
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
		expect(Object.keys(stored).sort()).toEqual(["repo", "review", "target"]);
		expect(stored.repo).toMatchObject({ root: repo, source: "cwd" });
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

	test("compile --improvements posts optional suggestions that stay out of the tally", () => {
		const repo = fixtureRepo();
		const diff = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		findingsFile(diff, [
			{ path: "src/a.ts", line: 2, kind: "improvement", tag: "cleanup", body: "Inline this." },
		]);
		const compile = (extra: string[]) =>
			JSON.parse(run(["compile", ".", "--diff", diff.diffPath, "--json", ...extra], { cwd: repo }).stdout);
		const off = compile([]);
		expect(JSON.parse(readFileSync(off.reviewPath, "utf8")).review.comments).toHaveLength(0);
		const on = compile(["--improvements"]);
		const stored = JSON.parse(readFileSync(on.reviewPath, "utf8")).review;
		expect(stored.improvements).toBe(1);
		expect(stored.comments[0].body).toStartWith("\u{1F4A1} **Improvement** `cleanup`");
		expect(on.tally).toEqual(off.tally);
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
	test.each([
		{ mode: "policy", policy: true },
		{ mode: "dedupe-only", policy: false },
	])(
		"compile handles unavailable review history in $mode mode",
		({ policy }) => {
			const gh = fakeGh(
				cliFixtures.shScript(`
  *"pr diff 12"*)
    cat "$FAKE_DIFF"
    ;;
  *"api graphql"*)
    echo 'review history unavailable' >&2
    exit 1
    ;;
  *"pr view 12"*)
    echo '{"headRefOid":"abc123"}'
    ;;`),
			);
			const cwd = cliFixtures.tmp(createdDirs, "thrash-history-");
			const diffFixture = join(cwd, "pr.diff");
			const policyPath = join(cwd, "policy.yml");
			writeFileSync(diffFixture, GH_DIFF);
			writeFileSync(policyPath, "phases:\n  - block: { high: 0 }\n");
			const env = {
				GH_BIN: gh.bin,
				FAKE_CALL_LOG: gh.log,
				FAKE_DIFF: diffFixture,
			};
			const diff = run(["diff", PR_URL], { cwd, env });
			expect(diff.exitCode, diff.stderr).toBe(EXIT.OK);
			const plan = JSON.parse(diff.stdout);
			findingsFile(plan, []);
			const result = run(
				[
					"compile",
					PR_URL,
					"--diff",
					plan.diffPath,
					"--json",
					...(policy ? ["--policy", policyPath] : []),
				],
				{ cwd, env },
			);
			expect(result.stderr).toContain("review history unavailable");
			if (policy) {
				expect(result.exitCode).toBe(EXIT.ERR);
				expect(result.stdout).not.toContain('"verdict"');
			} else {
				expect(result.exitCode, result.stderr).toBe(EXIT.OK);
				expect(JSON.parse(result.stdout).verdict).toBe("approve");
			}
		},
	);

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
		const inputs = cliFixtures.tmp(createdDirs, "thrash-inputs-");
		const diffFixture = join(inputs, "pr.diff");
		writeFileSync(diffFixture, GH_DIFF);
		const threadsFixture = join(inputs, "threads.json");
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
		expect(cliFixtures.readCalls(gh.log)).toContain(
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

		const post = run(["post", PR_URL, "--review", compiled.reviewPath, "--confirm"], {
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
			"**Verdict:** Request changes. 1 critical finding is open.",
		);

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

describe("review rounds via the GitHub adapter", () => {
	const DELTA_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,2 +3,3 @@
 const c = 4;
+const d = 5;
 export { a, b };
`;
	const LAST_SHA = "aaa1111222";
	const HEAD_SHA = "bbb2222333";
	const classMarker = (names: string[]) =>
		`<!-- dg:thrash-classes ${JSON.stringify(names)} -->\n${THRASH_REVIEW_MARKER}`;
	const thrashReview = (body: string, commit_id: string) => [
		[{ user: { login: "thrashley[bot]" }, body, state: "COMMENTED", commit_id }],
	];

	interface Setup {
		reviews?: unknown;
		status?: string;
		merged?: number;
		history?: unknown;
		historyFails?: boolean;
		prDiff?: string;
		delta?: string;
	}

	function rounds(setup: Setup = {}) {
		const dir = cliFixtures.tmp(createdDirs, "thrash-rounds-");
		const write = (name: string, text: string) => {
			const file = join(dir, name);
			writeFileSync(file, text);
			return file;
		};
		const mergedPrs = Array.from({ length: setup.merged ?? 0 }, (_, i) =>
			cliFixtures.restPr(30 + i, `merged-${i}`, { state: "closed", merged_at: "2026-01-01T00:00:00Z" }),
		);
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"--jq .status"*)
    if [ "$FAKE_STATUS" = "gone" ]; then echo 'gh: Not Found (HTTP 404)' >&2; exit 1; fi
    echo "$FAKE_STATUS"
    ;;
  *"/compare/"*)
    cat "$FAKE_DELTA"
    ;;
  *"pr diff 12"*)
    cat "$FAKE_DIFF"
    ;;
  *"pr view 12"*)
    echo '{"headRefOid":"${HEAD_SHA}"}'
    ;;
  *"pulls/12/reviews"*)
    cat "$FAKE_REVIEWS"
    ;;
  *"/pulls --method GET"*)
    if [ -n "$FAKE_HISTORY_FAILS" ]; then echo 'history unavailable' >&2; exit 1; fi
    cat "$FAKE_PRS"
    ;;
  *"/pulls/"*"/reviews"*)
    cat "$FAKE_HISTORY"
    ;;
  *"api graphql"*)
    if [ -e "$FAKE_THREADS_DOWN" ]; then echo 'threads unavailable' >&2; exit 1; fi
    echo '${EMPTY_THREADS}'
    ;;`),
		);
		const threadsDown = join(dir, "threads.down");
		const reviewsFile = write("reviews.json", JSON.stringify(setup.reviews ?? [[]]));
		const env: Record<string, string> = {
			GH_BIN: gh.bin,
			AI_VCS_PROVIDER: "github",
			FAKE_CALL_LOG: gh.log,
			FAKE_THREADS_DOWN: threadsDown,
			FAKE_DIFF: write("pr.diff", setup.prDiff ?? GH_DIFF),
			FAKE_DELTA: write("delta.diff", setup.delta ?? DELTA_DIFF),
			FAKE_STATUS: setup.status ?? "ahead",
			FAKE_REVIEWS: reviewsFile,
			FAKE_PRS: write("prs.json", JSON.stringify(mergedPrs)),
			FAKE_HISTORY: write("history.json", JSON.stringify(setup.history ?? [[]])),
			...(setup.historyFails ? { FAKE_HISTORY_FAILS: "1" } : {}),
		};
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
		const diff = () => {
			const result = run(["diff", PR_URL], { cwd, env });
			expect(result.exitCode, result.stderr).toBe(EXIT.OK);
			return JSON.parse(result.stdout);
		};
		const compile = (plan: { diffPath: string; chunks: Array<{ findingsPath: string }> }, findings: unknown[] = []) => {
			findingsFile(plan, findings);
			const result = run(["compile", PR_URL, "--diff", plan.diffPath, "--json"], { cwd, env });
			expect(result.exitCode, result.stderr).toBe(EXIT.OK);
			const { review } = JSON.parse(readFileSync(JSON.parse(result.stdout).reviewPath, "utf8"));
			return { review, stderr: result.stderr };
		};
		const breakThreads = () => writeFileSync(threadsDown, "");
		const breakReviews = () => writeFileSync(reviewsFile, "reviews unavailable");
		const compileRaw = (plan: { diffPath: string; chunks: Array<{ findingsPath: string }> }) => {
			findingsFile(plan, []);
			return run(["compile", PR_URL, "--diff", plan.diffPath, "--json"], { cwd, env });
		};
		return { diff, compile, compileRaw, breakThreads, breakReviews, gh };
	}

	test("reviews only the diff since the last reviewed commit and names it in the summary", () => {
		const { diff, compile, gh } = rounds({ reviews: thrashReview(classMarker([]), LAST_SHA) });
		const plan = diff();
		expect(plan.reReview).toEqual({ sha: LAST_SHA, files: 1, lines: 1 });
		expect(plan.stats).toMatchObject({ files: 1, added: 1, deleted: 0 });
		expect(cliFixtures.readCalls(gh.log).join("\n")).toContain(`compare/${LAST_SHA}...${HEAD_SHA}`);
		const { review } = compile(plan);
		expect(review.body).toContain(`> - Only the diff since \`${LAST_SHA.slice(0, 7)}\`: 1 file, 1 line.`);
	});

	test.each([
		["the commit is gone after a force push", "gone"],
		["the commit is not an ancestor of head", "diverged"],
	])("falls back to the full diff when %s", (_name, status) => {
		const { diff, compile } = rounds({ reviews: thrashReview(classMarker([]), LAST_SHA), status });
		const plan = diff();
		expect(plan.reReview).toBeUndefined();
		expect(plan.stats).toMatchObject({ files: 1, added: 2, deleted: 1 });
		expect(compile(plan).review.body).not.toContain("Re-review");
	});

	test("reviews the full diff when the thread lookup fails", () => {
		const { diff, breakThreads } = rounds({ reviews: thrashReview(classMarker([]), LAST_SHA) });
		breakThreads();
		const plan = diff();
		expect(plan.reReview).toBeUndefined();
		expect(plan.stats).toMatchObject({ added: 2, deleted: 1 });
	});

	test("refuses to compile a delta review when the thread lookup fails", () => {
		const { diff, compileRaw, breakThreads } = rounds({ reviews: thrashReview(classMarker([]), LAST_SHA) });
		const plan = diff();
		expect(plan.reReview).toBeDefined();
		breakThreads();
		const result = compileRaw(plan);
		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.stderr).toContain("threads unavailable");
		expect(result.stdout).not.toContain('"verdict"');
	});

	test("carries the cleared thread ids of the last review into the next review body", () => {
		const cleared = `<!-- dg:thrash-cleared ["PRRT_old"] -->\n${THRASH_REVIEW_MARKER}`;
		const { diff, compile } = rounds({ reviews: thrashReview(cleared, LAST_SHA) });
		const plan = diff();
		expect(plan.reReview).toBeDefined();
		expect(compile(plan).review.body).toContain('<!-- dg:thrash-cleared ["PRRT_old"] -->');
	});

	test("refuses to compile a delta review when the review lookup fails", () => {
		const { diff, compileRaw, breakReviews } = rounds({ reviews: thrashReview(classMarker([]), LAST_SHA) });
		const plan = diff();
		expect(plan.reReview).toBeDefined();
		breakReviews();
		const result = compileRaw(plan);
		expect(result.exitCode).toBe(EXIT.ERR);
		expect(result.stdout).not.toContain('"verdict"');
	});

	test("reviews the full diff while the last review left a blocker unposted", () => {
		const unposted = `<!-- dg:thrash-unposted ["missing await"] -->\n${THRASH_REVIEW_MARKER}`;
		const { diff } = rounds({ reviews: thrashReview(unposted, LAST_SHA) });
		const plan = diff();
		expect(plan.reReview).toBeUndefined();
		expect(plan.stats).toMatchObject({ added: 2, deleted: 1 });
	});

	test("posts delta findings at lines the full PR diff shows and as file comments elsewhere", () => {
		const prDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 export { a, b };
`;
		const delta = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,6 +1,5 @@
 const a = 1;
 const b = 3;
-const c = 4;
 export { a, b };
 const t1 = 1;
 const t2 = 2;
`;
		const { diff, compile } = rounds({ reviews: thrashReview(classMarker([]), LAST_SHA), prDiff, delta });
		const plan = diff();
		expect(plan.reReview).toMatchObject({ sha: LAST_SHA });
		const { review } = compile(plan, [
			{ path: "src/a.ts", line: 2, tier: "high", title: "On the PR diff", body: "First." },
			{ path: "src/a.ts", line: 4, tier: "medium", title: "Only in the delta", body: "Second." },
		]);
		const comments = review.comments as Array<{ title: string; newLine?: number; oldLine?: number }>;
		expect(comments.find((c) => c.title === "On the PR diff")?.newLine).toBe(2);
		const second = comments.find((c) => c.title === "Only in the delta");
		expect(second).toBeDefined();
		expect(second?.newLine).toBeUndefined();
		expect(second?.oldLine).toBeUndefined();
	});

	test("reviews the full diff in round 1", () => {
		const { diff } = rounds();
		expect(diff().stats).toMatchObject({ added: 2, deleted: 1 });
	});

	const classed = [
		{ path: "src/a.ts", line: 2, tier: "medium", title: "Missing await", class: "Missing await", body: "Not awaited." },
	];
	const HINT = "This class came up in 3 recent PRs. Consider a rule in docs/code_review.md or a lint check.";

	test("adds the repeated-class hint when 3 recent merged PRs hit the class", () => {
		const { diff, compile } = rounds({ merged: 3, history: thrashReview(classMarker(["missing await"]), "x1") });
		expect(compile(diff(), classed).review.body).toContain(HINT);
	});

	test("leaves the hint out when only 2 recent merged PRs hit the class", () => {
		const { diff, compile } = rounds({ merged: 2, history: thrashReview(classMarker(["missing await"]), "x1") });
		expect(compile(diff(), classed).review.body).not.toContain("recent PRs");
	});

	test("skips the hint without an error when the history read fails", () => {
		const { diff, compile } = rounds({ merged: 3, historyFails: true });
		const { review, stderr } = compile(diff(), classed);
		expect(review.body).not.toContain("recent PRs");
		expect(review.verdict).toBeDefined();
		expect(stderr).toContain("skipping the repeated-class hint");
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
    echo 'HTTP 403: approval forbidden for this reviewer' >&2
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
		const post = run(["post", url, "--review", compiled.reviewPath, "--confirm"], {
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

	test("post refuses an approve or request-changes event without --confirm", () => {
		const { env, cwd, reviewPath, log } = compiledGitlabReview();
		const before = cliFixtures.readCalls(log).length;
		const post = run(["post", url, "--review", reviewPath], { cwd, env });
		expect(post.exitCode).not.toBe(EXIT.OK);
		expect(post.stderr.toString()).toContain("--confirm");
		assertNoProviderCall(log, before);
	});

	test("post sends a comment-only review without --confirm", () => {
		const { env, cwd, reviewPath, log } = compiledGitlabReview();
		const stored = JSON.parse(readFileSync(reviewPath, "utf8"));
		stored.review.verdict = "comment";
		writeFileSync(reviewPath, JSON.stringify(stored));
		const before = cliFixtures.readCalls(log).length;
		const post = run(["post", url, "--review", reviewPath], { cwd, env });
		expect(post.stderr.toString()).not.toContain("--confirm");
		expect(
			cliFixtures.readCalls(log).slice(before).some((call) => call.includes("/draft_notes")),
		).toBe(true);
	});

	test("DG_THRASH_DRY_RUN=0 still posts", () => {
		const { env, cwd, reviewPath, log } = compiledGitlabReview();
		const before = cliFixtures.readCalls(log).length;
		const post = run(["post", url, "--review", reviewPath, "--confirm"], {
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
	let binary: string[];
	let skills: string;

	beforeAll(() => {
		installation = proxyFixtures();
		binary = relocatedProxyCli(installation);
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
		const bin = join(fixture.home, ".local", "bin");
		mkdirSync(bin, { recursive: true });
		const shim = join(bin, "dg-skills");
		writeFileSync(shim, `#!/bin/sh\nexec ${shellCommand(binary)} "$@"\n`);
		chmodSync(shim, 0o755);
	});
	afterEach(() => fixture?.cleanup());

	function execute(
		args: string[],
		options: { cwd?: string; env?: Record<string, string> } = {},
	): RunResult {
		const proc = Bun.spawnSync([...binary, ...args], {
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
		const bootstrap = skill.match(
			/```bash\n(\{ dg-skills thrash --help[\s\S]*?)\n```/,
		)?.[1];
		expect(bootstrap).toBeDefined();
		const proc = Bun.spawnSync(
			["sh", "-c", `${bootstrap}\n"$HOME/.local/bin/dg-skills" thrash diff "$TARGET"`],
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
		expect(skill).toContain("report `ADDRESS_FILE=` and offer `/dg:address -l`");
		const installed = readdirSync(skills, { recursive: true }).map((entry) =>
			basename(String(entry)),
		);
		for (const legacy of ["thrash-helper", "proxy-helper", "address-helper"]) {
			expect(installed).not.toContain(legacy);
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
			["thrash", "post", target, "--review", review.reviewPath, "--confirm"],
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
			/```text\n(You are running inside \/dg:thrash\.[\s\S]*?)\n```/,
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
const prompt = args.at(-1);
const session = resumed ? JSON.parse(readFileSync(process.env.FAKE_SESSION, "utf8")) : {
  id: "thrash-fixture-session", cwd: process.cwd(), path: prompt.match(/^FINDINGS_PATH: (.+)$/m)?.[1]
};
if (!session.path || (resumed && (args.at(-2) !== session.id || process.cwd() !== session.cwd))) process.exit(9);
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

describe("thrash review hardening", () => {
	test("diff clears findings left by an earlier run of the same target", () => {
		const repo = fixtureRepo();
		const first = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		const stale = findingsFile(first, [
			{ path: "src/a.ts", line: 2, tier: "critical", body: "Old finding." },
		]);
		expect(existsSync(stale)).toBe(true);
		const second = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		expect(second.chunks[0].findingsPath).toBe(stale);
		expect(existsSync(stale)).toBe(false);
		const compiled = run(["compile", ".", "--diff", second.diffPath], { cwd: repo });
		expect(compiled.exitCode).toBe(EXIT.ERR);
		expect(compiled.stderr).toContain("has no findings file");
	});

	test("compile removes a posted file left by an earlier review of the same target", () => {
		const repo = fixtureRepo();
		const diff = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		findingsFile(diff, [{ path: "src/a.ts", line: 2, tier: "low", body: "Rename." }]);
		const output = JSON.parse(
			run(["compile", ".", "--diff", diff.diffPath, "--json"], { cwd: repo }).stdout,
		);
		const posted = output.reviewPath.replace(/\.review\.json$/, ".posted.json");
		writeFileSync(posted, "{}");
		const again = run(["compile", ".", "--diff", diff.diffPath, "--json"], { cwd: repo });
		expect(again.exitCode).toBe(EXIT.OK);
		expect(existsSync(posted)).toBe(false);
	});

	test("local diff ignores diff.noprefix and diff.mnemonicPrefix settings", () => {
		const repo = fixtureRepo();
		cliFixtures.runGit(["config", "diff.noprefix", "true"], repo);
		cliFixtures.runGit(["config", "diff.mnemonicPrefix", "true"], repo);
		const out = JSON.parse(run(["diff", "."], { cwd: repo }).stdout);
		expect(out.stats).toMatchObject({ files: 1, added: 2, deleted: 1 });
	});

	test("stack accepts --diff before the target", () => {
		const pulls = [
			{
				number: 12,
				title: "one",
				html_url: PR_URL,
				state: "open",
				head: { ref: "a" },
				base: { ref: "main" },
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
		const result = run(["stack", "--diff", PR_URL], {
			cwd,
			env: { GH_BIN: gh.bin, FAKE_CALL_LOG: gh.log, FAKE_DIFF: diffFixture },
		});
		expect(result.exitCode).toBe(EXIT.OK);
		expect(JSON.parse(result.stdout)[0]).toMatchObject({ number: 12, changed: 3 });
	});
});

describe("thrash review checkout", () => {
	const PR_13 = PR_URL.replace("12", "13");
	const HEAD_FILE = "const a = 1;\nconst b = 3;\nconst c = 4;\nexport { a, b };\n";

	interface Remote {
		path: string;
		sha12: string;
		sha13: string;
	}

	function makeRemote(): Remote {
		const dir = cliFixtures.tmp(createdDirs, "thrash-remote-");
		cliFixtures.runGit(["init", "-q"], dir);
		cliFixtures.runGit(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
		cliFixtures.runGit(["config", "user.email", "t@t.t"], dir);
		cliFixtures.runGit(["config", "user.name", "T"], dir);
		mkdirSync(join(dir, "src"));
		cliFixtures.commitFile(dir, "src/a.ts", "const a = 1;\nconst b = 2;\nexport { a, b };\n", "chore: base");
		cliFixtures.runGit(["checkout", "-q", "-b", "pr"], dir);
		const sha12 = cliFixtures.commitFile(dir, "src/a.ts", HEAD_FILE, "feat: head 12");
		cliFixtures.runGit(["update-ref", "refs/pull/12/head", sha12], dir);
		const sha13 = cliFixtures.commitFile(dir, "src/a.ts", `${HEAD_FILE}// 13\n`, "feat: head 13");
		cliFixtures.runGit(["update-ref", "refs/pull/13/head", sha13], dir);
		cliFixtures.runGit(["checkout", "-q", "main"], dir);
		return { path: dir, sha12, sha13 };
	}

	interface Env {
		env: Record<string, string>;
		cwd: string;
		gh: ReturnType<typeof fakeGh>;
		cloneLog: string;
		headFile: string;
		postFlag: string;
	}

	function setup(remote: Remote, opts: { cloneFails?: boolean; cloneSleep?: number; postFails?: boolean } = {}): Env {
		const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
		const inputs = cliFixtures.tmp(createdDirs, "thrash-inputs-");
		const cloneLog = join(inputs, "clones.log");
		const headFile = join(inputs, "head");
		const diffFixture = join(inputs, "pr.diff");
		const pulls = join(inputs, "pulls.json");
		writeFileSync(headFile, remote.sha12);
		writeFileSync(diffFixture, GH_DIFF);
		const pr = (number: number, sha: string, head: string, base: string) => ({
			number,
			title: `PR ${number}`,
			html_url: PR_URL.replace("12", String(number)),
			state: "open",
			merged_at: null,
			head: { ref: head, sha },
			base: { ref: base },
		});
		writeFileSync(pulls, JSON.stringify([pr(12, remote.sha12, "a", "main"), pr(13, remote.sha13, "b", "a")]));
		const clone = opts.cloneFails
			? `echo clone >> "${cloneLog}"\n    exit 1`
			: `echo clone >> "${cloneLog}"\n    sleep ${opts.cloneSleep ?? 0}\n    dir="$4"; shift 5\n    exec git clone "$@" "file://${remote.path}" "$dir"`;
		const gh = fakeGh(
			cliFixtures.shScript(`
  *"repo clone"*)
    ${clone}
    ;;
  *"contents/"*)
    echo 'gh: Not Found (HTTP 404)' >&2
    exit 1
    ;;
  *"pr diff"*)
    cat "$FAKE_DIFF"
    ;;
  *"pr view"*)
    printf '{"number":12,"title":"t","body":"","headRefName":"a","baseRefName":"main","headRefOid":"%s"}' "$(cat "${headFile}")"
    ;;
  *"api graphql"*)
    echo '${EMPTY_THREADS}'
    ;;
  *"pulls --method GET"*)
    cat "${pulls}"
    ;;
  *"--method POST"*)
    ${opts.postFails ? "echo 'post failed' >&2; exit 1" : `cat > /dev/null; echo '{"html_url":"${PR_URL}#pullrequestreview-1"}'`}
    ;;
  *"pulls/"*"/reviews"*)
    echo '[[]]'
    ;;`),
		);
		return {
			env: { GH_BIN: gh.bin, FAKE_CALL_LOG: gh.log, FAKE_DIFF: diffFixture },
			cwd,
			gh,
			cloneLog,
			headFile,
			postFlag: "",
		};
	}

	function cloneCalls(e: Env): number {
		return cliFixtures.readCalls(e.cloneLog).length;
	}

	function diffOf(e: Env, args: string[] = [PR_URL]) {
		const result = run(["diff", ...args], { cwd: e.cwd, env: e.env });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const out = JSON.parse(result.stdout);
		const plan = JSON.parse(readFileSync(out.diffPath.replace(/\.diff$/, ".plan.json"), "utf8"));
		return { out, plan };
	}

	function compileOf(e: Env, out: { diffPath: string; chunks: Array<{ findingsPath: string }> }, url = PR_URL) {
		findingsFile(out, []);
		const result = run(["compile", url, "--diff", out.diffPath, "--json"], { cwd: e.cwd, env: e.env });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const reviewPath = JSON.parse(result.stdout).reviewPath as string;
		return { reviewPath, review: JSON.parse(readFileSync(reviewPath, "utf8")) };
	}

	function post(e: Env, reviewPath: string, url = PR_URL, extra: string[] = ["--confirm"]) {
		return run(["post", url, "--review", reviewPath, ...extra], { cwd: e.cwd, env: e.env });
	}

	test("diff builds a scratch tree at the PR head and reports it in the plan and on stdout", () => {
		const remote = makeRemote();
		const e = setup(remote);
		const { out, plan } = diffOf(e);
		expect(plan.repo).toMatchObject({ headSha: remote.sha12, source: "clone" });
		expect(isAbsolute(plan.repo.root)).toBe(false);
		expect(out.repo).toMatchObject({ headSha: remote.sha12, source: "clone" });
		expect(isAbsolute(out.repo.root)).toBe(true);
		expect(out.repo.root).toBe(join(dirname(out.diffPath), plan.repo.root));
		expect(out.repo.root.startsWith(scratch)).toBe(true);
		expect(readFileSync(join(out.repo.root, "src/a.ts"), "utf8")).toBe(HEAD_FILE);
	});

	test("diff exits 0 with source none when the clone fails", () => {
		const e = setup(makeRemote(), { cloneFails: true });
		const { out, plan } = diffOf(e);
		expect(plan.repo).toMatchObject({ root: "", source: "none" });
		expect(out.repo.source).toBe("none");
	});

	test("a second diff after the head moved gives a tree at the new head SHA", () => {
		const remote = makeRemote();
		const e = setup(remote);
		diffOf(e);
		writeFileSync(e.headFile, remote.sha13);
		cliFixtures.runGit(["update-ref", "refs/pull/12/head", remote.sha13], remote.path);
		const { out } = diffOf(e);
		expect(out.repo.headSha).toBe(remote.sha13);
		expect(readFileSync(join(out.repo.root, "src/a.ts"), "utf8")).toBe(`${HEAD_FILE}// 13\n`);
	});

	test.each([
		["before", ["--no-repo", PR_URL]],
		["after", [PR_URL, "--no-repo"]],
	])("diff --no-repo %s the URL skips the checkout and writes no repo key", (_label, args) => {
		const e = setup(makeRemote());
		const { out, plan } = diffOf(e, args);
		expect(out.target).toBe(PR_URL);
		expect("repo" in plan).toBe(false);
		expect("repo" in out).toBe(false);
		expect(cloneCalls(e)).toBe(0);
		expect(cliFixtures.readCalls(e.gh.log).some((call) => call.includes("contents/"))).toBe(false);
	});

	test("compile copies repo with an absolute root and notes a diff-only review only for source none", () => {
		const remote = makeRemote();
		const e = setup(remote);
		const { out } = diffOf(e);
		const { review } = compileOf(e, out);
		expect(review.repo).toEqual({ ...out.repo });
		expect(review.review.body).not.toContain("Review limits");

		const failing = setup(remote, { cloneFails: true });
		const none = diffOf(failing);
		expect(compileOf(failing, none.out).review.review.body).toContain(
			"Reviewed from the diff only: the code checkout was not available.",
		);
	});

	test("compile on a --no-repo plan has no diff-only line and no repo key", () => {
		const e = setup(makeRemote());
		const { out } = diffOf(e, [PR_URL, "--no-repo"]);
		const { review } = compileOf(e, out);
		expect("repo" in review).toBe(false);
		expect(review.review.body).not.toContain("Review limits");
	});

	test("post removes the scratch tree after a publish", () => {
		const e = setup(makeRemote());
		const { out } = diffOf(e);
		const { reviewPath } = compileOf(e, out);
		expect(existsSync(out.repo.root)).toBe(true);
		const result = post(e, reviewPath);
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(existsSync(out.repo.root)).toBe(false);
	});

	test("post leaves a repo.root outside thrash scratch in place", () => {
		const e = setup(makeRemote());
		const { out } = diffOf(e);
		const { reviewPath, review } = compileOf(e, out);
		const outside = cliFixtures.tmp(createdDirs, "thrash-outside-");
		writeFileSync(join(outside, "keep.txt"), "x");
		writeFileSync(reviewPath, JSON.stringify({ ...review, repo: { ...review.repo, root: outside } }));
		expect(post(e, reviewPath).exitCode).toBe(EXIT.OK);
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});

	test.each(["/", "scratch"])("post with repo.root %s deletes nothing", (which) => {
		const e = setup(makeRemote());
		const { out } = diffOf(e);
		const { reviewPath, review } = compileOf(e, out);
		const root = which === "/" ? "/" : dirname(out.repo.root);
		writeFileSync(reviewPath, JSON.stringify({ ...review, repo: { ...review.repo, root } }));
		expect(post(e, reviewPath).exitCode).toBe(EXIT.OK);
		expect(existsSync(out.repo.root)).toBe(true);
		expect(existsSync(out.diffPath)).toBe(true);
	});

	test("post --dry-run removes the scratch tree and makes no provider call", () => {
		const e = setup(makeRemote());
		const { out } = diffOf(e);
		const { reviewPath } = compileOf(e, out);
		const before = cliFixtures.readCalls(e.gh.log).length;
		const result = post(e, reviewPath, PR_URL, ["--dry-run"]);
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(existsSync(out.repo.root)).toBe(false);
		expect(cliFixtures.readCalls(e.gh.log).slice(before)).toEqual([]);
	});

	test("post keeps the tree after a failed publish and after a refusal for a missing --confirm", () => {
		const e = setup(makeRemote(), { postFails: true });
		const { out } = diffOf(e);
		const { reviewPath } = compileOf(e, out);
		expect(post(e, reviewPath, PR_URL, []).exitCode).not.toBe(EXIT.OK);
		expect(existsSync(out.repo.root)).toBe(true);
		expect(post(e, reviewPath).exitCode).not.toBe(EXIT.OK);
		expect(existsSync(out.repo.root)).toBe(true);
	});

	test("post exits as before for a review file with no repo", () => {
		const e = setup(makeRemote());
		const { out } = diffOf(e, [PR_URL, "--no-repo"]);
		const { reviewPath } = compileOf(e, out);
		expect(post(e, reviewPath).exitCode).toBe(EXIT.OK);
	});

	test("post reads repo from the review file and never from plan.json", () => {
		const e = setup(makeRemote());
		const { out } = diffOf(e);
		const { reviewPath, review } = compileOf(e, out);
		const { repo: _repo, ...bare } = review;
		writeFileSync(reviewPath, JSON.stringify(bare));
		expect(post(e, reviewPath).exitCode).toBe(EXIT.OK);
		expect(existsSync(out.repo.root)).toBe(true);
	});

	test("stack --diff makes one clone for two open PRs and each post removes only its own tree", () => {
		const e = setup(makeRemote(), { cloneSleep: 0.2 });
		const result = run(["stack", PR_URL, "--diff"], { cwd: e.cwd, env: e.env });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const rows = JSON.parse(result.stdout) as Array<{
			number: number;
			diffPath: string;
			chunks: Array<{ findingsPath: string }>;
			repo: { root: string; headSha: string; source: string };
		}>;
		expect(cloneCalls(e)).toBe(1);
		expect(rows.map((row) => row.repo.source)).toEqual(["clone", "clone"]);
		expect(new Set(rows.map((row) => row.repo.root)).size).toBe(2);
		expect(rows.every((row) => isAbsolute(row.repo.root))).toBe(true)
		const shared = readdirSync(dirname(rows[0].repo.root)).find((name) => name.startsWith("clone-"));
		expect(shared).toBeDefined();
		const sharedDir = join(dirname(rows[0].repo.root), shared ?? "");

		const [first, second] = rows.map((row) => compileOf(e, row, PR_URL.replace("12", String(row.number))));
		expect(post(e, first.reviewPath, PR_URL).exitCode).toBe(EXIT.OK);
		expect(existsSync(rows[0].repo.root)).toBe(false);
		expect(existsSync(rows[1].repo.root)).toBe(true);
		expect(existsSync(sharedDir)).toBe(true);
		const last = post(e, second.reviewPath, PR_13);
		expect(last.exitCode, last.stderr).toBe(EXIT.OK);
		expect(existsSync(rows[1].repo.root)).toBe(false);
		expect(existsSync(sharedDir)).toBe(false);
	});

	test("stack --diff --no-repo prints no repo key and makes no clone", () => {
		const e = setup(makeRemote());
		const result = run(["stack", PR_URL, "--diff", "--no-repo"], { cwd: e.cwd, env: e.env });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(JSON.parse(result.stdout).some((row: object) => "repo" in row)).toBe(false);
		expect(cloneCalls(e)).toBe(0);
	});

	test("stack --diff plans bundles for each PR from its own tree", () => {
		const e = setup(makeRemote());
		const result = run(["stack", PR_URL, "--diff"], { cwd: e.cwd, env: e.env });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const rows = JSON.parse(result.stdout) as Array<{
			chunks: Array<{ bundle?: object; contextPath: string }>;
		}>;
		const contextPaths = rows.map((row) => row.chunks[0].contextPath);
		expect(rows.every((row) => row.chunks[0].bundle !== undefined)).toBe(true);
		expect(contextPaths.every((p) => isAbsolute(p) && existsSync(p))).toBe(true);
		expect(new Set(contextPaths).size).toBe(2);
	});

	test("stack --diff makes no per-PR clone when the shared clone fails", () => {
		const e = setup(makeRemote(), { cloneFails: true });
		const result = run(["stack", PR_URL, "--diff"], { cwd: e.cwd, env: e.env });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(cloneCalls(e)).toBe(1);
		expect(JSON.parse(result.stdout).map((row: { repo: { source: string } }) => row.repo.source)).toEqual(["none", "none"]);
	});

	test("--help names --no-repo", () => {
		const result = run(["--help"]);
		expect(`${result.stdout}${result.stderr}`).toContain("--no-repo");
	});
});

describe("thrash review bundles", () => {
	function lines(prefix: string, count: number): string {
		return Array.from({ length: count }, (_, i) => `export const ${prefix}${i} = ${i};\n`).join("");
	}

	function twoConcernRepo(): string {
		const dir = makeTempDir("thrash-bundle-repo-");
		createdDirs.push(dir);
		cliFixtures.runGit(["init", "-q"], dir);
		cliFixtures.runGit(["symbolic-ref", "HEAD", "refs/heads/main"], dir);
		cliFixtures.runGit(["config", "user.email", "t@t.t"], dir);
		cliFixtures.runGit(["config", "user.name", "T"], dir);
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "lib"));
		cliFixtures.commitFile(dir, "src/x.ts", "export const base = 0;\n", "chore: base x");
		cliFixtures.commitFile(dir, "lib/y.ts", "export const other = 0;\n", "chore: base y");
		cliFixtures.runGit(["checkout", "-q", "-b", "feature"], dir);
		writeFileSync(join(dir, "src/x.ts"), `export const base = 0;\n${lines("xv", 250)}`);
		writeFileSync(join(dir, "lib/y.ts"), `export const other = 0;\n${lines("yv", 250)}`);
		return dir;
	}

	function shimGit(script: (realGit: string) => string): Record<string, string> {
		const dir = cliFixtures.tmp(createdDirs, "thrash-git-shim-");
		const realGit = Bun.which("git") ?? "git";
		writeFileSync(join(dir, "git"), script(realGit), { mode: 0o755 });
		return { PATH: `${dir}:${process.env.PATH}` };
	}

	function diffOut(repo: string, args: string[] = ["."], env: Record<string, string> = {}) {
		const result = run(["diff", ...args], { cwd: repo, env });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		return { result, out: JSON.parse(result.stdout) };
	}

	test("diff . writes one bundle per unrelated concern with an existing context file", () => {
		const repo = twoConcernRepo();
		const { out } = diffOut(repo);
		expect(out.chunks).toHaveLength(2);
		for (const chunk of out.chunks) {
			expect(chunk.bundle).toBeDefined();
			expect(existsSync(chunk.contextPath)).toBe(true);
		}
		expect(out.chunks.map((c: { files: string[] }) => c.files)).toEqual([["lib/y.ts"], ["src/x.ts"]]);
	});

	test("diff --no-repo on the same change gives one chunk with no bundle fields", () => {
		const repo = twoConcernRepo();
		const { out } = diffOut(repo, [".", "--no-repo"]);
		expect(out.chunks).toHaveLength(1);
		expect(out.chunks[0]).not.toHaveProperty("bundle");
		expect(out.chunks[0]).not.toHaveProperty("contextPath");
	});

	test("diff . warns and plans plain chunks when git grep exits 2", () => {
		const repo = twoConcernRepo();
		const env = shimGit(
			(realGit) => `#!/bin/sh\nfor a in "$@"; do [ "$a" = grep ] && exit 2; done\nexec ${realGit} "$@"\n`,
		);
		const { result, out } = diffOut(repo, ["."], env);
		expect(result.stderr).toContain("investigate failed");
		expect(out.chunks).toHaveLength(1);
		expect(out.chunks[0]).not.toHaveProperty("bundle");
		expect(out.chunks[0]).not.toHaveProperty("contextPath");
	});

	test("DG_THRASH_INVESTIGATE_BUDGET_MS=0 warns, lists truncated files and still plans bundles", () => {
		const repo = twoConcernRepo();
		const { result, out } = diffOut(repo, ["."], { DG_THRASH_INVESTIGATE_BUDGET_MS: "0" });
		expect(result.stderr).toContain("investigate budget ended; 2 file(s) truncated");
		expect(out.chunks).toHaveLength(2);
		const context = readFileSync(out.chunks[0].contextPath, "utf8");
		expect(context).toContain("## Truncated files");
		expect(context).toContain("- lib/y.ts");
	});

	test("diff rejects a budget that is not a whole number", () => {
		const repo = twoConcernRepo();
		const result = run(["diff", "."], { cwd: repo, env: { DG_THRASH_INVESTIGATE_BUDGET_MS: "soon" } });
		expect(result.exitCode).not.toBe(EXIT.OK);
		expect(result.stderr).toContain("DG_THRASH_INVESTIGATE_BUDGET_MS");
	});

	test("diff prints an absolute contextPath and plan.json keeps a plan-relative one", () => {
		const repo = twoConcernRepo();
		const { out } = diffOut(repo);
		const plan = JSON.parse(readFileSync(out.diffPath.replace(/\.diff$/, ".plan.json"), "utf8"));
		for (const [i, chunk] of out.chunks.entries()) {
			expect(isAbsolute(chunk.contextPath)).toBe(true);
			expect(isAbsolute(plan.chunks[i].contextPath)).toBe(false);
			expect(join(dirname(out.diffPath), plan.chunks[i].contextPath)).toBe(chunk.contextPath);
		}
	});

	test("a second diff with fewer bundles leaves no bundle file of the first run", () => {
		const repo = twoConcernRepo();
		const first = diffOut(repo).out;
		expect(first.chunks).toHaveLength(2);
		const stale = first.chunks[1].contextPath as string;
		expect(existsSync(stale)).toBe(true);
		cliFixtures.runGit(["checkout", "--", "lib/y.ts"], repo);
		const second = diffOut(repo).out;
		expect(second.chunks).toHaveLength(1);
		expect(existsSync(second.chunks[0].contextPath)).toBe(true);
		expect(existsSync(stale)).toBe(false);
	});

	test("the bundle context names a caller of a changed function with its call line", () => {
		const repo = makeTempDir("thrash-caller-repo-");
		createdDirs.push(repo);
		cliFixtures.runGit(["init", "-q"], repo);
		cliFixtures.runGit(["symbolic-ref", "HEAD", "refs/heads/main"], repo);
		cliFixtures.runGit(["config", "user.email", "t@t.t"], repo);
		cliFixtures.runGit(["config", "user.name", "T"], repo);
		mkdirSync(join(repo, "src"));
		cliFixtures.commitFile(repo, "src/a.ts", "export function total(x: number) {\n\treturn x;\n}\n", "chore: a");
		cliFixtures.commitFile(
			repo,
			"src/b.ts",
			'import { total } from "./a";\n\nexport const sum = total(1);\n',
			"chore: b",
		);
		cliFixtures.runGit(["checkout", "-q", "-b", "feature"], repo);
		writeFileSync(join(repo, "src/a.ts"), "export function total(x: number, y: number) {\n\treturn x + y;\n}\n");
		const { out } = diffOut(repo);
		const context = readFileSync(out.chunks[0].contextPath, "utf8");
		expect(context).toContain("src/b.ts:3");
		expect(out.chunks[0].bundle.dependents).toContain("src/b.ts");
	});

	test("investigate prints the investigation JSON for a file", () => {
		const repo = twoConcernRepo();
		const result = run(["investigate", "src/x.ts"], { cwd: repo });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const out = JSON.parse(result.stdout);
		expect(out.root).toBe(repo);
		expect(out.files).toHaveLength(1);
		expect(out.files[0]).toMatchObject({ path: "src/x.ts", truncated: false });
	});

	test("investigate with no path fails", () => {
		const result = run(["investigate"], { cwd: twoConcernRepo() });
		expect(result.exitCode).not.toBe(EXIT.OK);
		expect(result.stderr).toContain("investigate requires one or more paths");
	});

	test("investigate accepts --max-hits of 1 or more and rejects anything else", () => {
		const repo = twoConcernRepo();
		for (const bad of ["0", "abc", "1.5"]) {
			const result = run(["investigate", "src/x.ts", "--max-hits", bad], { cwd: repo });
			expect(result.exitCode, bad).not.toBe(EXIT.OK);
			expect(result.stderr).toContain("--max-hits");
		}
		const ok = run(["investigate", "--max-hits", "5", "src/x.ts"], { cwd: repo });
		expect(ok.exitCode, ok.stderr).toBe(EXIT.OK);
		expect(JSON.parse(ok.stdout).files.map((f: { path: string }) => f.path)).toEqual(["src/x.ts"]);
	});

	test("investigate caps callers at --max-hits and marks the file truncated", () => {
		const repo = twoConcernRepo();
		cliFixtures.commitFile(repo, "src/use.ts", "x1();\nx1();\nx1();\n", "chore: use");
		cliFixtures.commitFile(repo, "src/x.ts", "export const x1 = 1;\n", "chore: x1");
		const out = JSON.parse(run(["investigate", "src/x.ts", "--max-hits", "2"], { cwd: repo }).stdout);
		expect(out.files[0].callers).toHaveLength(2);
		expect(out.files[0].truncated).toBe(true);
	});

	test("investigate expands a directory to tracked files only", () => {
		const repo = twoConcernRepo();
		writeFileSync(join(repo, "src/untracked.ts"), "export const u = 1;\n");
		const result = run(["investigate", "src"], { cwd: repo });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(JSON.parse(result.stdout).files.map((f: { path: string }) => f.path)).toEqual(["src/x.ts"]);
	});

	test("investigate resolves paths from a subdirectory and prints them relative to the root", () => {
		const repo = twoConcernRepo();
		const result = run(["investigate", "x.ts"], { cwd: join(repo, "src") });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		expect(JSON.parse(result.stdout).files[0].path).toBe("src/x.ts");
	});

	test("investigate rejects a path outside the repository", () => {
		const repo = twoConcernRepo();
		const outside = cliFixtures.tmp(createdDirs, "thrash-outside-");
		writeFileSync(join(outside, "o.ts"), "export const o = 1;\n");
		const result = run(["investigate", join(outside, "o.ts")], { cwd: repo });
		expect(result.exitCode).not.toBe(EXIT.OK);
		expect(result.stderr).toContain("outside the repository");
	});

	test("investigate outside a git repository gives a clear error", () => {
		const dir = cliFixtures.tmp(createdDirs, "thrash-nogit-");
		writeFileSync(join(dir, "o.ts"), "export const o = 1;\n");
		const result = run(["investigate", "o.ts"], { cwd: dir });
		expect(result.exitCode).not.toBe(EXIT.OK);
		expect(result.stderr).toContain("not inside a git repository");
	});
});

describe("thrash triage review", () => {
	const GOLDEN = join(import.meta.dir, "fixtures", "thrash", "no-triage.review.json");
	const CRITICAL = { path: "src/a.ts", line: 3, tier: "critical", title: "Crash", body: "Crashes on empty input." };
	const HIGH = { path: "src/a.ts", line: 2, tier: "high", title: "Leak", body: "Leaks a handle." };
	const MEDIUM = { path: "src/a.ts", line: 2, tier: "medium", title: "Slow", body: "Scans twice." };

	interface Flow {
		repo: string;
		diff: { diffPath: string; chunks: Array<{ findingsPath: string }> };
		consolidated: string;
		inputPath: string;
	}

	function localDiff(extra: string[] = []) {
		const repo = fixtureRepo();
		const result = run(["diff", ".", ...extra], { cwd: repo });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		return { repo, diff: JSON.parse(result.stdout) };
	}

	function triaged(findings: unknown[], spice = "3"): Flow {
		const { repo, diff } = localDiff();
		findingsFile(diff, findings);
		const merge = run(["triage", "--diff", diff.diffPath, "--stage", "merge", "--spice", spice], { cwd: repo });
		expect(merge.exitCode, merge.stderr).toBe(EXIT.OK);
		const apply = run(["triage", "--diff", diff.diffPath, "--stage", "apply"], { cwd: repo });
		expect(apply.exitCode, apply.stderr).toBe(EXIT.OK);
		const out = JSON.parse(apply.stdout);
		return { repo, diff, consolidated: out.consolidatedPath, inputPath: out.consolidateInputPath };
	}

	function compile(flow: Flow) {
		const result = run(["compile", ".", "--diff", flow.diff.diffPath, "--json"], { cwd: flow.repo });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const out = JSON.parse(result.stdout);
		const stored = JSON.parse(readFileSync(out.reviewPath, "utf8"));
		return { out, stored, review: stored.review, stderr: result.stderr };
	}

	function consolidate(flow: Flow, findings: unknown[], extra: Record<string, unknown> = {}) {
		writeFileSync(flow.consolidated, JSON.stringify({ changed: "", strengths: [], opportunities: [], findings, ...extra }));
	}

	test("compile with no triage files writes the same review file as before triage existed", () => {
		const { repo, diff } = localDiff(["--no-repo"]);
		findingsFile(diff, [
			{ path: "src/a.ts", line: 2, tier: "critical", body: "Breaks callers." },
			{ path: "src/a.ts", line: 3, tier: "low", body: "Rename this." },
		]);
		const result = run(["compile", ".", "--diff", diff.diffPath, "--json"], { cwd: repo });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const stored = readFileSync(JSON.parse(result.stdout).reviewPath, "utf8");
		expect(stored).toBe(readFileSync(GOLDEN, "utf8"));
	});

	test("compile with neither a consolidated file nor a consolidate input posts the chunk findings", () => {
		const { repo, diff } = localDiff();
		findingsFile(diff, [HIGH]);
		const result = run(["compile", ".", "--diff", diff.diffPath, "--json"], { cwd: repo });
		expect(result.exitCode, result.stderr).toBe(EXIT.OK);
		const stored = JSON.parse(readFileSync(JSON.parse(result.stdout).reviewPath, "utf8"));
		expect(stored.review.comments).toHaveLength(1);
		expect(stored).not.toHaveProperty("rejected");
		expect(result.stderr).not.toContain("consolidated");
	});

	test("compile posts the findings of a parseable consolidated file", () => {
		const flow = triaged([HIGH]);
		consolidate(flow, [{ id: "c1-1", title: "New title", body: "New body." }]);
		const { review, stderr } = compile(flow);
		expect(stderr).toBe("");
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0]).toMatchObject({ title: "New title", tier: "high" });
		expect(review.comments[0].body).toContain("New body.");
	});

	test("compile warns about a broken consolidated file and posts the consolidate input findings", () => {
		const flow = triaged([HIGH]);
		writeFileSync(flow.consolidated, "not json at all");
		const { review, stderr } = compile(flow);
		expect(stderr).toContain("thrash: consolidated file does not parse");
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0].body).toContain("Leaks a handle.");
	});

	test("compile keeps the tier and the anchor of the verified set when the consolidated file changes them", () => {
		const flow = triaged([HIGH]);
		consolidate(flow, [{ id: "c1-1", title: "New title", body: "New body.", tier: "low", line: 9 }]);
		const { review } = compile(flow);
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0]).toMatchObject({ tier: "high", newLine: 2, title: "New title" });
		expect(review.comments[0].body).toContain("New body.");
	});

	test("compile drops a consolidated finding with an unknown id and names it on stderr", () => {
		const flow = triaged([HIGH]);
		consolidate(flow, [
			{ id: "c1-1", body: "Kept." },
			{ id: "c9-9", body: "Ghost." },
		]);
		const { review, stderr } = compile(flow);
		expect(stderr).toContain("c9-9");
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0].body).not.toContain("Ghost.");
	});

	test("compile keeps a critical finding the consolidated file leaves out", () => {
		const flow = triaged([HIGH, CRITICAL]);
		consolidate(flow, [{ id: "c1-1", body: "Kept." }]);
		const { review } = compile(flow);
		expect(review.verdict).toBe("request_changes");
		expect(review.comments.map((c: { tier: string }) => c.tier).sort()).toEqual(["critical", "high"]);
	});

	test("compile groups a higher finding under a keeper and gives one comment with the higher tier", () => {
		const flow = triaged([MEDIUM, { ...HIGH, line: 3, title: "Leak", body: "Leaks elsewhere." }]);
		consolidate(flow, [{ id: "c1-1", body: "One class.", class: "resource-use", otherPlaces: ["src/a.ts:3"] }]);
		const { review } = compile(flow);
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0].tier).toBe("high");
	});

	test("compile does not group a critical finding under a pre-existing keeper", () => {
		const flow = triaged([{ ...MEDIUM, preExisting: true, line: 1 }, CRITICAL]);
		consolidate(flow, [{ id: "c1-1", body: "Old issue.", class: "resource-use", otherPlaces: ["src/a.ts:3"] }]);
		const { review } = compile(flow);
		expect(review.verdict).toBe("request_changes");
		expect(review.comments.map((c: { tier: string }) => c.tier)).toContain("critical");
	});

	test("compile does not count an unverified finding that the consolidator grouped under another", () => {
		const flow = triaged([MEDIUM, { ...HIGH, line: 3 }]);
		const ungrouped = compile(flow);
		expect(ungrouped.review.body).toContain("2 findings not verified.");
		consolidate(flow, [{ id: "c1-1", body: "One class.", class: "resource-use", otherPlaces: ["src/a.ts:3"] }]);
		const { review } = compile(flow);
		expect(review.body).toContain("1 finding not verified.");
		expect(review.body).not.toContain("2 findings not verified.");
	});

	test("compile lists two rejected findings in the summary and in the review file with their reasons", () => {
		const { repo, diff } = localDiff();
		findingsFile(diff, [HIGH, CRITICAL]);
		const merge = JSON.parse(
			run(["triage", "--diff", diff.diffPath, "--stage", "merge"], { cwd: repo }).stdout,
		) as { tasks: Array<{ id: string; verdictPath: string }> };
		for (const task of merge.tasks) {
			writeFileSync(task.verdictPath, JSON.stringify({ id: task.id, verdict: "rejected", reason: `no ${task.id}` }));
		}
		const apply = run(["triage", "--diff", diff.diffPath, "--stage", "apply"], { cwd: repo });
		expect(JSON.parse(apply.stdout)).toMatchObject({ rejected: 2, confirmed: 0 });
		const { stored, review } = compile({ repo, diff, consolidated: "", inputPath: "" });
		expect(review.comments).toHaveLength(0);
		expect(review.body).toContain("2 findings rejected on verification.");
		expect(stored.rejected).toEqual([
			{ id: "c1-2", tier: "critical", title: "Crash", reason: "no c1-2" },
			{ id: "c1-1", tier: "high", title: "Leak", reason: "no c1-1" },
		]);
		expect(review).not.toHaveProperty("rejected");
	});

	test("a second diff removes the consolidate input and the consolidated file of the first run", () => {
		const flow = triaged([HIGH]);
		consolidate(flow, [{ id: "c1-1", body: "Kept." }]);
		expect(existsSync(flow.inputPath)).toBe(true);
		const again = run(["diff", "."], { cwd: flow.repo });
		expect(again.exitCode, again.stderr).toBe(EXIT.OK);
		expect(existsSync(flow.inputPath)).toBe(false);
		expect(existsSync(flow.consolidated)).toBe(false);
	});

	test("triage with a missing or invalid --stage exits non-zero and names both values", () => {
		const { repo, diff } = localDiff();
		for (const args of [["--stage"], ["--stage", "bogus"], []]) {
			const result = run(["triage", "--diff", diff.diffPath, ...args], { cwd: repo });
			expect(result.exitCode).not.toBe(EXIT.OK);
			expect(result.stderr).toContain("merge");
			expect(result.stderr).toContain("apply");
		}
	});

	test("triage rejects a spice outside 1 to 5 with the error compile gives", () => {
		const { repo, diff } = localDiff();
		findingsFile(diff, [HIGH]);
		const triage = run(["triage", "--diff", diff.diffPath, "--stage", "merge", "--spice", "9"], { cwd: repo });
		const compileResult = run(["compile", ".", "--diff", diff.diffPath, "--spice", "9"], { cwd: repo });
		expect(triage.exitCode).not.toBe(EXIT.OK);
		const message = (stderr: string) => stderr.replace(/^thrash \w+: /, "");
		expect(message(triage.stderr)).toBe(message(compileResult.stderr));
	});

	test("apply with a merged file and no tasks file exits non-zero and names the tasks file", () => {
		const flow = triaged([HIGH]);
		rmSync(flow.inputPath);
		const tasks = flow.consolidated.replace(/\.consolidated\.md$/, ".verify.tasks.json");
		rmSync(tasks);
		const result = run(["triage", "--diff", flow.diff.diffPath, "--stage", "apply"], { cwd: flow.repo });
		expect(result.exitCode).not.toBe(EXIT.OK);
		expect(result.stderr).toContain("verify.tasks.json");
	});

	describe("prior threads", () => {
		const FINDING = { path: "src/a.ts", line: 2, tier: "critical", title: "Crash", body: "Crashes on empty input." };

		function remote(thread: unknown | null) {
			const dir = cliFixtures.tmp(createdDirs, "thrash-shield-");
			const diffFile = join(dir, "pr.diff");
			const threads = join(dir, "threads.json");
			writeFileSync(diffFile, GH_DIFF);
			const gh = fakeGh(
				cliFixtures.shScript(`
  *"pr diff 12"*)
    cat "$FAKE_DIFF"
    ;;
  *"pr view 12"*)
    echo '{"headRefOid":"abc123"}'
    ;;
  *"api graphql"*)
    cat "$FAKE_THREADS"
    ;;
  *"reviews"*)
    echo '[[]]'
    ;;`),
			);
			const env = { GH_BIN: gh.bin, AI_VCS_PROVIDER: "github", FAKE_CALL_LOG: gh.log, FAKE_DIFF: diffFile, FAKE_THREADS: threads };
			const cwd = cliFixtures.tmp(createdDirs, "thrash-cwd-");
			const diff = JSON.parse(run(["diff", PR_URL], { cwd, env }).stdout);
			findingsFile(diff, [FINDING]);
			const first = run(["compile", PR_URL, "--diff", diff.diffPath, "--json"], { cwd, env });
			expect(first.exitCode, first.stderr).toBe(EXIT.OK);
			const body = JSON.parse(readFileSync(JSON.parse(first.stdout).reviewPath, "utf8")).review.comments[0].body;
			const nodes = thread
				? [
						{
							id: "thread-1",
							isResolved: false,
							isOutdated: true,
							path: "src/a.ts",
							line: null,
							originalLine: 2,
							comments: {
								nodes: [
									{ databaseId: 1, author: { login: "thrashley[bot]" }, body, createdAt: "2026-02-01T00:00:00Z", diffHunk: GH_DIFF },
								],
							},
						},
					]
				: [];
			writeFileSync(
				threads,
				JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage: false } } } } } }),
			);
			return { cwd, env, diff };
		}

		function compileWithInput(setup: ReturnType<typeof remote>, rejected: unknown[]) {
			const input = setup.diff.diffPath.replace(/\.diff$/, ".consolidate.input.json");
			writeFileSync(
				input,
				JSON.stringify({ changed: "Adds a.", strengths: [], opportunities: [], findings: [], rejected, unverified: [] }),
			);
			const policy = join(dirname(input), "policy.yml");
			writeFileSync(policy, "phases:\n  - block:\n      critical: 0\n");
			const result = run(["compile", PR_URL, "--diff", setup.diff.diffPath, "--policy", policy, "--json"], {
				cwd: setup.cwd,
				env: setup.env,
			});
			expect(result.exitCode, result.stderr).toBe(EXIT.OK);
			return JSON.parse(result.stdout);
		}

		test("compile with the consolidate input and one rejected entry keeps the prior blocker thread open", () => {
			const setup = remote(true);
			const cleared = compileWithInput(setup, []);
			expect(cleared.tally.critical).toBe(0);
			const shielded = compileWithInput(setup, [{ ...FINDING, side: "new", id: "c1-1", reason: "guarded upstream" }]);
			expect(shielded.tally.critical).toBe(1);
			expect(shielded.verdict).toBe("request_changes");
		});
	});
});
