import { afterAll, afterEach, beforeAll } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface WriteFakeCliOptions {
	/** "suite" puts the dir on PATH from beforeAll until afterAll instead of per test. */
	scope?: "test" | "suite";
}

const testScopedDirs = new Set<string>();

function prepend(dir: string): void {
	process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
}

function remove(dir: string): void {
	process.env.PATH = (process.env.PATH ?? "")
		.split(":")
		.filter((entry) => entry !== dir)
		.join(":");
}

function drainTestScopedDirs(): void {
	for (const dir of testScopedDirs) remove(dir);
	testScopedDirs.clear();
}

/** Auto-restores PATH after the test, or after the describe block when `opts.scope` is "suite". */
export function writeFakeCli(dir: string, binName: string, script: string, opts?: WriteFakeCliOptions): void {
	const path = join(dir, binName);
	writeFileSync(path, script);
	chmodSync(path, 0o755);

	if (opts?.scope === "suite") {
		beforeAll(() => prepend(dir));
		afterAll(() => remove(dir));
		return;
	}
	if (testScopedDirs.size === 0) afterEach(drainTestScopedDirs);
	testScopedDirs.add(dir);
	prepend(dir);
}
