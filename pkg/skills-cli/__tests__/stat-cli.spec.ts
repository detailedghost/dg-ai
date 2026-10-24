import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, runCli } from "./module-call";

function withEnv(root: string): Record<string, string> {
	return {
		...process.env,
		HOME: join(root, "home"),
		AI_SCRATCH_DIR: join(root, "scratch"),
		AI_STATE_DIR: join(root, "state"),
	} as Record<string, string>;
}

async function withRoot<T>(run: (env: Record<string, string>, root: string) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "dg-stat-cli-"));
	try {
		return await run(withEnv(root), root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function stat(args: string[], env: Record<string, string>, cwd: string) {
	return runCli(["bun", CLI_ENTRY], ["stat", ...args], { cwd, env });
}

function checklistFile(stateDir: string): string {
	const buckets = readdirSync(join(stateDir, "stat"));
	const hits = buckets
		.map((bucket) => join(stateDir, "stat", bucket, "checklist.md"))
		.filter((path) => existsSync(path));
	if (hits.length !== 1) throw new Error(`expected one checklist, found ${hits.join(", ")}`);
	return hits[0] as string;
}

describe("dg-skills stat mutations", () => {
	test("add reports the sanitized stored text, not a mere trim of the argument", async () => {
		await withRoot(async (env, root) => {
			const run = await stat(["add", "  foo\tbar\nbaz  "], env, root);
			expect(run.exitCode).toBe(0);
			expect(JSON.parse(run.stdout)).toEqual({
				kind: "checklist-item-added",
				order: "1",
				text: "foo bar baz",
			});
		});
	});

	test("add keeps text that ends in an eta bucket, and done can still match it", async () => {
		await withRoot(async (env, root) => {
			const added = await stat(["add", "Investigate [unknown]"], env, root);
			expect(added.exitCode).toBe(0);
			const listed = await stat(["checklist", "--json"], env, root);
			expect(JSON.parse(listed.stdout).open[0]).toMatchObject({
				text: "Investigate [unknown]",
				eta: null,
			});
			const done = await stat(["done", "Investigate [unknown]"], env, root);
			expect(done.exitCode).toBe(0);
			const after = JSON.parse((await stat(["checklist", "--json"], env, root)).stdout);
			expect(after.done[0]).toMatchObject({ text: "Investigate [unknown]", status: "done" });
		});
	});

	test("done and status reach an unfinished child after its parent is done", async () => {
		await withRoot(async (env, root) => {
			expect((await stat(["add", "parent", "--status", "running"], env, root)).exitCode).toBe(0);
			expect((await stat(["add", "child task", "--under", "1"], env, root)).exitCode).toBe(0);
			expect((await stat(["done", "parent"], env, root)).exitCode).toBe(0);
			const status = await stat(["status", "child task", "queued", "--eta", "~15 min"], env, root);
			expect(status.exitCode).toBe(0);
			expect(status.stderr).toBe("");
			const done = await stat(["done", "child task"], env, root);
			expect(done.exitCode).toBe(0);
			const json = JSON.parse((await stat(["checklist", "--json"], env, root)).stdout);
			expect(json.done[0].children[0]).toMatchObject({ status: "done", text: "child task" });
		});
	});

	test("a lock held by a live process blocks add and leaves the checklist unchanged", async () => {
		await withRoot(async (env, root) => {
			expect((await stat(["add", "keep"], env, root)).exitCode).toBe(0);
			const file = checklistFile(env.AI_STATE_DIR as string);
			const before = readFileSync(file, "utf8");
			writeFileSync(`${file}.lock`, String(process.pid));
			const blocked = await stat(["add", "dropped"], env, root);
			expect(blocked.exitCode).toBe(1);
			expect(blocked.stderr).toContain("is held");
			expect(readFileSync(file, "utf8")).toBe(before);
			expect(existsSync(`${file}.lock`)).toBe(true);
		});
	}, 20_000);

	test("a lock whose owner is gone is taken over and then released", async () => {
		await withRoot(async (env, root) => {
			expect((await stat(["add", "keep"], env, root)).exitCode).toBe(0);
			const file = checklistFile(env.AI_STATE_DIR as string);
			writeFileSync(`${file}.lock`, "2147483646");
			const run = await stat(["add", "next"], env, root);
			expect(run.exitCode).toBe(0);
			expect(existsSync(`${file}.lock`)).toBe(false);
			const json = JSON.parse((await stat(["checklist", "--json"], env, root)).stdout);
			expect(json.open.map((item: { text: string }) => item.text)).toEqual(["keep", "next"]);
		});
	});

	test("concurrent adds all land", async () => {
		await withRoot(async (env, root) => {
			const runs = await Promise.all(["a", "b", "c", "d"].map((text) => stat(["add", text], env, root)));
			expect(runs.map((run) => run.exitCode)).toEqual([0, 0, 0, 0]);
			const json = JSON.parse((await stat(["checklist", "--json"], env, root)).stdout);
			expect(json.open.map((item: { text: string }) => item.text).sort()).toEqual(["a", "b", "c", "d"]);
			const file = checklistFile(env.AI_STATE_DIR as string);
			expect(existsSync(`${file}.lock`)).toBe(false);
		});
	});
});
