import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
