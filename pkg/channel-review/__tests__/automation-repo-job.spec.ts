import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepoJobRunner, sweepCloneRoot } from "../src/automation/repo-job";
import { createFakeCapture, createRecordedLog } from "./support/fakes";

const REPO = { host: "github.com", owner: "example-org", repo: "app" };
const roots: string[] = [];

function tempRoot(): string {
	const dir = mkdtempSync(join(tmpdir(), "repo-job-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(cloneStatus = 0) {
	const root = join(tempRoot(), "clones");
	const fake = createFakeCapture(({ args }) => {
		if (cloneStatus !== 0) return { status: cloneStatus, stderr: "no such branch" };
		mkdirSync(args[3] as string, { recursive: true });
		writeFileSync(join(args[3] as string, "README.md"), "x");
		return { status: 0 };
	});
	const log = createRecordedLog();
	const run = createRepoJobRunner({ capture: fake.runner, cloneRoot: root, log, suffix: () => "abc123" });
	const base = {
		id: "fix/dd:1",
		repo: REPO,
		branch: "main",
		timeoutMs: 5_000,
		signal: new AbortController().signal,
		task: async () => {},
		finish: async () => "done",
	};
	return { root, fake, log, run, base };
}

describe("runRepoJob", () => {
	test("clones the branch into a slugged directory, runs the steps in order, and cleans up", async () => {
		const { root, fake, run, base } = setup();
		const order: string[] = [];
		const outcome = await run({
			...base,
			prepare: async ({ dir }) => {
				order.push(`prepare ${existsSync(dir)}`);
			},
			task: async ({ dir }) => {
				order.push(`task ${dir}`);
			},
			finish: async ({ dir }) => {
				order.push(`finish ${existsSync(join(dir, "README.md"))}`);
				return "pr";
			},
		});
		const dir = join(root, "fix-dd-1-abc123");
		expect(outcome).toEqual({ kind: "ok", value: "pr" });
		expect(order).toEqual(["prepare true", `task ${dir}`, "finish true"]);
		expect(fake.calls).toEqual([
			{
				command: "gh",
				args: ["repo", "clone", "github.com/example-org/app", dir, "--", "--branch", "main", "--single-branch"],
			},
		]);
		expect(readdirSync(root)).toEqual([]);
	});

	test("reports a clone failure and removes nothing outside the root", async () => {
		const { root, run, base } = setup(1);
		const outcome = await run(base);
		expect(outcome.kind).toBe("error");
		expect(String((outcome as { error: Error }).error)).toContain("no such branch");
		expect(readdirSync(root)).toEqual([]);
	});

	test("removes the clone when the task throws and skips finish", async () => {
		const { root, run, base } = setup();
		let finished = false;
		const outcome = await run({
			...base,
			task: async () => {
				throw new Error("agent crashed");
			},
			finish: async () => {
				finished = true;
				return "x";
			},
		});
		expect(outcome.kind).toBe("error");
		expect(finished).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	test("removes the clone when finish throws", async () => {
		const { root, run, base } = setup();
		const outcome = await run({
			...base,
			finish: async () => {
				throw new Error("push failed");
			},
		});
		expect(outcome.kind).toBe("error");
		expect(readdirSync(root)).toEqual([]);
	});

	test("times out, aborts the task signal, and skips finish", async () => {
		const { root, run, base } = setup();
		let seen: AbortSignal | undefined;
		let finished = false;
		const outcome = await run({
			...base,
			timeoutMs: 10,
			task: ({ signal }) => {
				seen = signal;
				return new Promise<void>(() => {});
			},
			finish: async () => {
				finished = true;
				return "x";
			},
		});
		expect(outcome).toEqual({ kind: "timeout" });
		expect(seen?.aborted).toBe(true);
		expect(finished).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	test("reports an abort from the caller and skips finish", async () => {
		const { root, run, base } = setup();
		const controller = new AbortController();
		let finished = false;
		const outcome = await run({
			...base,
			signal: controller.signal,
			task: async () => {
				controller.abort();
			},
			finish: async () => {
				finished = true;
				return "x";
			},
		});
		expect(outcome).toEqual({ kind: "aborted" });
		expect(finished).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});

	test("refuses to delete a directory outside the clone root", async () => {
		const outside = tempRoot();
		writeFileSync(join(outside, "keep.txt"), "x");
		const log = createRecordedLog();
		const fake = createFakeCapture(() => ({ status: 0 }));
		const run = createRepoJobRunner({
			capture: fake.runner,
			cloneRoot: join(outside, "root"),
			log,
			suffix: () => "../../escape",
		});
		await run({
			id: "x",
			repo: REPO,
			branch: "main",
			timeoutMs: 1000,
			signal: new AbortController().signal,
			task: async () => {},
			finish: async () => "x",
		});
		expect(existsSync(join(outside, "keep.txt"))).toBe(true);
	});
});

describe("sweepCloneRoot", () => {
	test("removes every entry except the active ids and ignores a missing root", () => {
		const root = tempRoot();
		for (const name of ["fix-a-1", "fix-b-2", "deps-c-3"]) {
			mkdirSync(join(root, name));
			writeFileSync(join(root, name, "f"), "x");
		}
		const log = createRecordedLog();
		sweepCloneRoot(root, ["fix-b"], log);
		expect(readdirSync(root)).toEqual(["fix-b-2"]);
		sweepCloneRoot(join(root, "absent"), [], log);
		expect(log.lines).toEqual([]);
	});

	test("leaves the root itself in place", () => {
		const root = tempRoot();
		sweepCloneRoot(root, [], createRecordedLog());
		expect(existsSync(root)).toBe(true);
	});
});
