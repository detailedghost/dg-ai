import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { git, makeTempDir } from "./git-repo-fixtures";
import { collectRun, type SpecRun } from "./spec-fixtures";

const ENTRY = join(import.meta.dir, "../src/index.ts");
const SESSION = "feed5678";
interface ReviewPayload {
	template: string;
	_secured: boolean;
	title: string;
	review: { head: string; files: { path: string; newContent?: string }[] };
	review_result?: unknown;
}

const BRANCH = "feat/readable-title";
const HEAD_SUBJECT = "wire up the second thing";

let root: string;
let vizDir: string;

function viz(args: string[], cwd = root): Promise<SpecRun> {
	return collectRun(
		Bun.spawn([process.execPath, ENTRY, "viz", ...args], {
			cwd,
			env: {
				HOME: join(root, "home"),
				PATH: process.env.PATH ?? "",
				VIZ_DIR: vizDir,
				VIZ_NO_BROWSER: "1",
				CLAUDE_CODE_SESSION_ID: SESSION,
				AI_SCRATCH_DIR: join(root, "scratch"),
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
}

function writeInput(payload: Record<string, unknown>): string {
	const path = join(root, `input-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(path, JSON.stringify(payload));
	return path;
}

function boardDir(run: SpecRun): string {
	const path = /VIZ_PATH=(\S+)/.exec(run.stdout)?.[1];
	if (!path) throw new Error(`no VIZ_PATH in ${run.stdout}`);
	return path.replace(/\/payload\.json$/, "");
}

beforeEach(() => {
	root = makeTempDir("dg-viz-src-");
	vizDir = join(root, "viz");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("dg-skills viz render input validation", () => {
	test.each([
		["a path traversal slug", "../../../../tmp/viz-poc-evil"],
		["a dot-dot slug", ".."],
		["a dot slug", "."],
		["a slug with a slash", "foo/bar"],
		["a slug with unicode", "plan-ééé"],
		["a slug over 255 characters", "a".repeat(256)],
	])("rejects %s with a clean invalid slug error", async (_name, slug) => {
		const run = await viz([
			"--input",
			writeInput({ template: "plan", slug }),
			"--no-open",
		]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toMatch(/invalid slug/i);
		expect(run.stderr).not.toMatch(/ENAMETOOLONG|at validateSlug/);
		expect(existsSync("/tmp/viz-poc-evil")).toBe(false);
	});

	test("rejects an empty slug and a numeric slug without a raw TypeError", async () => {
		const empty = await viz([
			"--input",
			writeInput({ template: "plan", slug: "" }),
			"--no-open",
		]);
		expect(empty.exitCode).toBe(1);
		expect(empty.stderr).toMatch(/missing required field: slug|invalid slug/);
		const numeric = await viz([
			"render",
			"--input",
			writeInput({ template: "plan", slug: 12345 }),
			"--no-open",
		]);
		expect(numeric.exitCode).toBe(1);
		expect(numeric.stderr).not.toContain("TypeError");
		expect(numeric.stderr).toContain("dg-skills viz:");
	});

	test("accepts the spec template, no template, and a leading dash slug", async () => {
		for (const payload of [
			{ template: "spec", slug: "specboard" },
			{ slug: "notemplate" },
			{ template: "plan", slug: "-lead" },
		]) {
			const run = await viz(["--input", writeInput(payload), "--no-open"]);
			expect(run.exitCode, run.stderr).toBe(0);
			expect(run.stderr).not.toMatch(/unknown template|missing required/);
			expect(boardDir(run).startsWith(vizDir)).toBe(true);
		}
	});

	test("re-rendering a slug keeps its board nonce", async () => {
		const first = await viz([
			"--input",
			writeInput({ template: "plan", slug: "stable" }),
			"--no-open",
		]);
		const token = readFileSync(join(boardDir(first), ".token"), "utf8");
		const second = await viz([
			"--input",
			writeInput({ template: "plan", slug: "stable" }),
			"--no-open",
		]);
		expect(readFileSync(join(boardDir(second), ".token"), "utf8")).toBe(token);
	});

	test("an unknown template is rejected naming the valid ones", async () => {
		const run = await viz([
			"--input",
			writeInput({ template: "bogus", slug: "x" }),
			"--no-open",
		]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("plan, recap, spec");
	});
});

describe("dg-skills viz session verbs reject bad input cleanly", () => {
	test("a non-numeric wait timeout is a validation error and leaves no stale marker", async () => {
		const render = await viz([
			"--input",
			writeInput({ template: "plan", slug: "waitbad" }),
			"--no-open",
		]);
		const slug = boardDir(render).split("/").pop() as string;
		const run = await viz(["wait", slug, "--timeout", "garbage"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("invalid --timeout");
		expect(run.stderr).not.toContain("NaN");
		expect(existsSync(join(vizDir, slug, ".stale"))).toBe(false);
	});

	test.each([
		["get", ["get", "../../etc", "--keys"]],
		["phase", ["phase", "../../etc", "p1", "done"]],
	])(
		"%s with an invalid slug prints one clean line, not a stack trace",
		async (_name, args) => {
			const run = await viz(args);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain("dg-skills viz: invalid slug");
			expect(run.stderr).not.toContain("at validateSlug");
		},
	);

	test("an unknown verb falls through to render and reports the bad argument", async () => {
		const run = await viz(["frobnicate"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("unknown argument: frobnicate");
	});
});

describe("dg-skills viz review", () => {
	let repo: string;

	beforeEach(() => {
		repo = join(root, "repo");
		Bun.spawnSync(["mkdir", "-p", repo]);
		git(["init", "-q", "-b", BRANCH], repo);
		git(["commit", "-q", "--allow-empty", "-m", "base commit"], repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", "add the first thing"], repo);
		writeFileSync(join(repo, "b.md"), "# two\n");
		git(["add", "-A"], repo);
		git(["commit", "-q", "-m", HEAD_SUBJECT], repo);
	});

	function review(head: string): Promise<SpecRun> {
		return viz([
			"review",
			"--repo",
			repo,
			"--base",
			"HEAD~2",
			"--head",
			head,
			"--no-open",
		]);
	}

	function payloadOf(run: SpecRun): ReviewPayload {
		return JSON.parse(
			readFileSync(join(boardDir(run), "payload.json"), "utf8"),
		);
	}

	test("builds a secured review payload from the git range and arms the verdict marker", async () => {
		const run = await review("HEAD");
		expect(run.exitCode, run.stderr).toBe(0);
		const payload = payloadOf(run);
		expect(payload.template).toBe("review");
		expect(payload._secured).toBe(true);
		expect(payload.review.files.map((f) => f.path)).toEqual(["a.txt", "b.md"]);
		expect(payload.review.files[1].newContent).toBe("# two\n");
		expect(payload.review.head).toMatch(/^[0-9a-f]{40}$/);
		const dir = boardDir(run);
		expect(existsSync(join(dir, ".token"))).toBe(true);
		expect(existsSync(join(dir, ".awaiting-verdict"))).toBe(true);
	});

	test("titles the board from the named ref, the branch, or the head subject", async () => {
		expect(payloadOf(await review("HEAD")).title).toBe(
			`Code Review: ${BRANCH}`,
		);
		expect(payloadOf(await review(BRANCH)).title).toBe(
			`Code Review: ${BRANCH}`,
		);
		const sha = git(["rev-parse", "HEAD"], repo).trim();
		git(["checkout", "-q", "--detach", sha], repo);
		git(["branch", "-q", "-D", BRANCH], repo);
		expect(payloadOf(await review("HEAD")).title).toBe(
			`Code Review: ${HEAD_SUBJECT}`,
		);
	});

	test("a failing git range exits 1 with the git failure", async () => {
		const run = await viz([
			"review",
			"--repo",
			repo,
			"--base",
			"no-such-ref",
			"--head",
			"HEAD",
			"--no-open",
		]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("git ");
		expect(run.stderr).toContain("failed");
	});

	test("get --require-fresh rejects a stale head, a missing submission, then accepts a fresh verdict", async () => {
		const run = await review("HEAD");
		const dir = boardDir(run);
		const slug = dir.split("/").pop() as string;
		const head = payloadOf(run).review.head;

		const stale = await viz([
			"get",
			slug,
			"review_result",
			"--require-fresh",
			"0".repeat(40),
		]);
		expect(stale.exitCode).toBe(1);

		const payload = payloadOf(run);
		payload.review_result = { verdict: "approve" };
		writeFileSync(join(dir, "payload.json"), JSON.stringify(payload));
		const unsubmitted = await viz([
			"get",
			slug,
			"review_result",
			"--require-fresh",
			head,
		]);
		expect(unsubmitted.exitCode).toBe(1);
		expect(unsubmitted.stderr).toContain("no submission recorded");

		writeFileSync(join(dir, "response.json"), "{}");
		const fresh = await viz([
			"get",
			slug,
			"review_result",
			"--require-fresh",
			head,
		]);
		expect(fresh.exitCode, fresh.stderr).toBe(0);
		expect(JSON.parse(fresh.stdout)).toEqual({ verdict: "approve" });
		expect(existsSync(join(dir, ".awaiting-verdict"))).toBe(false);
		expect(readdirSync(dir)).not.toContain(".awaiting-verdict");
	});
});
