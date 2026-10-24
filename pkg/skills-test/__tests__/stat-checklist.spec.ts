/**
 * Black-box checks for `dg-skills stat`: the POSIX table actually parses with
 * `awk`, the plain view is actually ASCII, and both the plain and default
 * views survive a real run through `marked` with the structure the checklist
 * is supposed to have (nested ordered lists, task items for --plain).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { marked } from "marked";
import { REPO_ROOT } from "./test-support";

const ENTRY = join(REPO_ROOT, "pkg", "skills-cli", "src", "index.ts");

async function runCli(
	args: string[],
	env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
	const proc = Bun.spawn(["bun", ENTRY, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

async function runAwk(args: string[], input: string): Promise<string> {
	const proc = Bun.spawn(["awk", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	proc.stdin.write(input);
	await proc.stdin.end();
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out;
}

function withEnv(root: string): Record<string, string> {
	return {
		HOME: root,
		AI_SCRATCH_DIR: join(root, "scratch"),
		AI_STATE_DIR: join(root, "state"),
	};
}

async function withRoot<T>(run: (env: Record<string, string>) => Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "dg-stat-checklist-"));
	try {
		return await run(withEnv(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("dg-skills stat checklist", () => {
	test("-l output parses cleanly with POSIX awk -F '\\t': one NF across every non-# line", async () => {
		await withRoot(async (env) => {
			await runCli(["stat", "add", "Phone feature to PR", "--status", "running", "--eta", "~1 hr"], env);
			await runCli(["stat", "add", "Fix the flaky listener test", "--status", "running", "--under", "1"], env);
			await runCli(["stat", "add", "Approve the Wave 6/7 PR batch", "--status", "blocked-user"], env);
			const { code, out } = await runCli(["stat", "checklist", "-l"], env);
			expect(code).toBe(0);
			const nfLines = (await runAwk(["-F", "\t", "!/^#/ {print NF}"], out)).trim().split("\n");
			expect(new Set(nfLines)).toEqual(new Set(["7"]));
			const statusColumn = await runAwk(["-F", "\t", "!/^#/ && NR>1 {print $3}"], out);
			expect(statusColumn.trim().split("\n")).toEqual(["running", "running", "blocked-user"]);
		});
	});

	test("--long is a usable alias for -l", async () => {
		await withRoot(async (env) => {
			await runCli(["stat", "add", "x"], env);
			const short = await runCli(["stat", "checklist", "-l"], env);
			const long = await runCli(["stat", "checklist", "--long"], env);
			expect(long.out).toBe(short.out);
		});
	});

	test("-p output is pure ASCII, even when item text is not", async () => {
		await withRoot(async (env) => {
			await runCli(["stat", "add", "café ünïcode ☕", "--status", "running", "--eta", "~1 hr"], env);
			await runCli(["stat", "add", "plain"], env);
			await runCli(["stat", "done", "plain"], env);
			const { code, out } = await runCli(["stat", "checklist", "-p"], env);
			expect(code).toBe(0);
			for (let i = 0; i < out.length; i++) expect(out.charCodeAt(i)).toBeLessThan(0x80);
			expect(out).toContain("caf? ?n?code ?");
		});
	});

	test("--plain is a usable alias for -p", async () => {
		await withRoot(async (env) => {
			await runCli(["stat", "add", "x"], env);
			const short = await runCli(["stat", "checklist", "-p"], env);
			const long = await runCli(["stat", "checklist", "--plain"], env);
			expect(long.out).toBe(short.out);
		});
	});

	test("-p renders through marked as nested <ol> task-list items, matching the stored order", async () => {
		await withRoot(async (env) => {
			await runCli(["stat", "add", "Phone feature to PR", "--status", "running"], env);
			await runCli(["stat", "add", "Fix the flaky listener test", "--status", "running", "--under", "1"], env);
			await runCli(["stat", "add", "Slice 6"], env);
			await runCli(["stat", "done", "Slice 6"], env);
			const { out } = await runCli(["stat", "checklist", "-p"], env);
			const body = out.split("\n\n")[0] ?? out;
			const html = marked.parse(body, { gfm: true }) as string;
			expect(html).toContain("<ol>");
			const checkboxes = [...html.matchAll(/<input ([^>]*)type="checkbox">/g)];
			expect(checkboxes).toHaveLength(3);
			expect(checkboxes.filter(([, attrs]) => attrs.includes("checked"))).toHaveLength(1);
			const nestedOl = /<li><input[^>]*>[^<]*<ol>/.test(html);
			expect(nestedOl).toBe(true);
		});
	});

	test("default and -p views put exactly one blank line before the Total line", async () => {
		await withRoot(async (env) => {
			await runCli(["stat", "add", "Phone feature to PR", "--status", "running", "--eta", "~1 hr"], env);
			const emoji = await runCli(["stat", "checklist"], env);
			expect(emoji.out).toMatch(/Phone feature to PR \[~1 hr\]\n\nTotal: /);
			const plain = await runCli(["stat", "checklist", "-p"], env);
			expect(plain.out).toMatch(/Phone feature to PR \[~1 hr\]\n\n# Total: /);
		});
	});

	test("an empty checklist reports one line on every view, and --json carries no file into existence", async () => {
		await withRoot(async (env) => {
			const emoji = await runCli(["stat", "checklist"], env);
			expect(emoji.out).toBe('No checklist yet. Add one with: ~/.dg/bin/dg-skills stat add "<text>"\n');
			const json = await runCli(["stat", "checklist", "--json"], env);
			expect(JSON.parse(json.out)).toEqual({ open: [], done: [], total: null });
			const after = await runCli(["stat", "checklist"], env);
			expect(after.out).toBe(emoji.out);
		});
	});

	test("done on an ambiguous match exits non-zero and lists every candidate", async () => {
		await withRoot(async (env) => {
			await runCli(["stat", "add", "Slice 6"], env);
			await runCli(["stat", "add", "Slice 6b"], env);
			const { code, err } = await runCli(["stat", "done", "Slice 6"], env);
			expect(code).toBe(1);
			expect(err).toContain("Slice 6");
			expect(err).toContain("Slice 6b");
		});
	});

	test("checklist -l and -p together is a usage error", async () => {
		await withRoot(async (env) => {
			const { code, err } = await runCli(["stat", "checklist", "-l", "-p"], env);
			expect(code).toBe(1);
			expect(err).toContain("pass only one of");
		});
	});

	test("status reopens a done item at the end of the open list and keeps the checklist file's numbering fresh", async () => {
		await withRoot(async (env) => {
			await runCli(["stat", "add", "a"], env);
			await runCli(["stat", "add", "b"], env);
			await runCli(["stat", "done", "a"], env);
			await runCli(["stat", "status", "a", "queued"], env);
			const { out } = await runCli(["stat", "checklist"], env);
			expect(out.split("\n").filter(Boolean)).toEqual(["1. ⏳ b", "2. ⏳ a", "Total: unknown"]);
		});
	});
});
