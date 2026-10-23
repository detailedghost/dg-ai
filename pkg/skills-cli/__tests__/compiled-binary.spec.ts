import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sweepStaleCompiledDirs } from "./compiled-binary";
import { makeTempDir } from "./git-repo-fixtures";

const HOUR_MS = 60 * 60 * 1000;

const roots: string[] = [];

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sweepRoot(): string {
	const dir = makeTempDir("dg-sweep-root-");
	roots.push(dir);
	return dir;
}

function compiledDir(root: string, name: string): string {
	const dir = join(root, `dg-skills-compiled-${name}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function deadPid(): number {
	return Bun.spawnSync(["sh", "-c", "exit 0"]).pid;
}

describe("sweepStaleCompiledDirs", () => {
	test("removes a dir whose owner pid is dead", () => {
		const root = sweepRoot();
		const dir = compiledDir(root, "dead");
		writeFileSync(join(dir, "owner.pid"), String(deadPid()));
		sweepStaleCompiledDirs(root, join(root, "dg-skills-compiled-current"));
		expect(existsSync(dir)).toBe(false);
	});

	test("keeps a dir whose owner pid is alive", () => {
		const root = sweepRoot();
		const dir = compiledDir(root, "live");
		writeFileSync(join(dir, "owner.pid"), String(process.pid));
		sweepStaleCompiledDirs(root, join(root, "dg-skills-compiled-current"));
		expect(existsSync(dir)).toBe(true);
	});

	test("removes a pid-less dir older than an hour", () => {
		const root = sweepRoot();
		const dir = compiledDir(root, "old-no-pid");
		const old = new Date(Date.now() - 2 * HOUR_MS);
		utimesSync(dir, old, old);
		sweepStaleCompiledDirs(root, join(root, "dg-skills-compiled-current"));
		expect(existsSync(dir)).toBe(false);
	});

	test("keeps a fresh pid-less dir", () => {
		const root = sweepRoot();
		const dir = compiledDir(root, "fresh-no-pid");
		sweepStaleCompiledDirs(root, join(root, "dg-skills-compiled-current"));
		expect(existsSync(dir)).toBe(true);
	});

	test("never removes the current run's dir, even if it looks dead", () => {
		const root = sweepRoot();
		const current = compiledDir(root, "current");
		const old = new Date(Date.now() - 2 * HOUR_MS);
		utimesSync(current, old, old);
		sweepStaleCompiledDirs(root, current);
		expect(existsSync(current)).toBe(true);
	});
});

describe("buildCompiledBinary signal and failure cleanup", () => {
	test("SIGTERM during a build removes the temp dir and exits 143", async () => {
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, "compiled-binary-signal-fixture.ts")],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let seen = "";
		const deadline = Date.now() + 15_000;
		while (!seen.includes("\n") && Date.now() < deadline) {
			const next = await reader.read();
			if (next.done) break;
			seen += decoder.decode(next.value);
		}
		const binary = seen.trim();
		expect(binary.length).toBeGreaterThan(0);
		const root = dirname(dirname(binary));
		child.kill("SIGTERM");
		expect(await child.exited).toBe(143);
		expect(existsSync(root)).toBe(false);
	}, 20_000);

	test("cleans up the temp dir before throwing on a failed build", async () => {
		const child = Bun.spawn(
			[process.execPath, join(import.meta.dir, "compiled-binary-failure-fixture.ts")],
			{ env: process.env, stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(stdout.trim()).toBe("OK");
	}, 20_000);
});
