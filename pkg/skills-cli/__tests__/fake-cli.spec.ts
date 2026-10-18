import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeFakeCli } from "./fake-cli";

const originalPath = process.env.PATH;
const dirsToClean: string[] = [];
let pathBeforeSuiteScopeBlock: string | undefined;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fake-cli-test-"));
	dirsToClean.push(dir);
	return dir;
}

afterAll(() => {
	process.env.PATH = originalPath;
	for (const dir of dirsToClean) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("writeFakeCli — writes an executable binary", () => {
	test("running the written binary by its bare name produces the given script's output", () => {
		const dir = tempDir();
		writeFakeCli(dir, "fake-widget", '#!/bin/sh\necho "widget output"\nexit 0\n');

		const result = Bun.spawnSync(["fake-widget"], { stdout: "pipe", stderr: "pipe", env: process.env });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("widget output");
	});

	test("the written file carries an executable permission bit", () => {
		const dir = tempDir();
		writeFakeCli(dir, "fake-perm-check", "#!/bin/sh\nexit 0\n");
		const mode = statSync(join(dir, "fake-perm-check")).mode;
		expect(mode & 0o111).not.toBe(0);
	});

	test("a nonzero exit and stderr from the script surface through Bun.spawnSync unchanged", () => {
		const dir = tempDir();
		writeFakeCli(dir, "fake-failer", '#!/bin/sh\necho "boom" 1>&2\nexit 7\n');
		const result = Bun.spawnSync(["fake-failer"], { stdout: "pipe", stderr: "pipe", env: process.env });
		expect(result.exitCode).toBe(7);
		expect(result.stderr.toString().trim()).toBe("boom");
	});
});

describe("writeFakeCli — prepends dir to process.env.PATH", () => {
	test("dir becomes the first PATH entry, and the prior PATH is preserved after it", () => {
		const before = process.env.PATH ?? "";
		const dir = tempDir();
		writeFakeCli(dir, "fake-path-check", "#!/bin/sh\nexit 0\n");
		const after = process.env.PATH ?? "";
		expect(after.startsWith(dir)).toBe(true);
		expect(after.endsWith(before)).toBe(true);
	});

	test("two fake binaries written to two different dirs both resolve, most-recent dir winning on a name collision", () => {
		const dirA = tempDir();
		const dirB = tempDir();
		writeFakeCli(dirA, "fake-shared-name", '#!/bin/sh\necho "from A"\nexit 0\n');
		writeFakeCli(dirB, "fake-shared-name", '#!/bin/sh\necho "from B"\nexit 0\n');
		const result = Bun.spawnSync(["fake-shared-name"], { stdout: "pipe", stderr: "pipe", env: process.env });
		expect(result.stdout.toString().trim()).toBe("from B");
	});
});

describe("writeFakeCli — restores PATH via an auto-registered afterEach", () => {
	let pathBeforeFirstCall: string | undefined;

	test("first test: writeFakeCli mutates PATH without the caller registering any cleanup itself", () => {
		pathBeforeFirstCall = process.env.PATH;
		const dir = tempDir();
		writeFakeCli(dir, "fake-restore-check", "#!/bin/sh\nexit 0\n");
		expect(process.env.PATH).not.toBe(pathBeforeFirstCall);
		expect(process.env.PATH?.startsWith(dir)).toBe(true);
	});

	test("second test: PATH is already back to its pre-call value, proving the afterEach fired automatically", () => {
		expect(process.env.PATH).toBe(pathBeforeFirstCall);
	});
});

describe("writeFakeCli — multiple calls within a single test each restore correctly", () => {
	let pathBeforeMultiCallTest: string | undefined;

	test("first test: two writeFakeCli calls in the same test (e.g. a fake gh and a fake glab together)", () => {
		pathBeforeMultiCallTest = process.env.PATH;
		const dirA = tempDir();
		const dirB = tempDir();
		writeFakeCli(dirA, "fake-multi-a", "#!/bin/sh\nexit 0\n");
		writeFakeCli(dirB, "fake-multi-b", "#!/bin/sh\nexit 0\n");
		expect(process.env.PATH).toBe(`${dirB}:${dirA}:${pathBeforeMultiCallTest}`);
	});

	test("second test: PATH is fully restored, not left holding either temp dir from the prior test's two calls", () => {
		expect(process.env.PATH).toBe(pathBeforeMultiCallTest);
	});
});

describe("writeFakeCli — two fakes sharing one dir (the gh + glab pairing adapters need)", () => {
	let pathBeforeSharedDirTest: string | undefined;

	test("first test: both binaries written into the same dir resolve by bare name", () => {
		pathBeforeSharedDirTest = process.env.PATH;
		const dir = tempDir();
		writeFakeCli(dir, "fake-paired-gh", '#!/bin/sh\necho "paired gh"\nexit 0\n');
		writeFakeCli(dir, "fake-paired-glab", '#!/bin/sh\necho "paired glab"\nexit 0\n');

		const ghResult = Bun.spawnSync(["fake-paired-gh"], { stdout: "pipe", stderr: "pipe", env: process.env });
		const glabResult = Bun.spawnSync(["fake-paired-glab"], { stdout: "pipe", stderr: "pipe", env: process.env });
		expect(ghResult.stdout.toString().trim()).toBe("paired gh");
		expect(glabResult.stdout.toString().trim()).toBe("paired glab");
	});

	test("second test: PATH is restored exactly after two calls naming the same dir", () => {
		expect(process.env.PATH).toBe(pathBeforeSharedDirTest);
	});
});

describe("writeFakeCli — rewriting the same binName in one test", () => {
	test("the later script replaces the earlier one rather than both lingering", () => {
		const dir = tempDir();
		writeFakeCli(dir, "fake-rewritten", '#!/bin/sh\necho "first"\nexit 0\n');
		writeFakeCli(dir, "fake-rewritten", '#!/bin/sh\necho "second"\nexit 0\n');
		const result = Bun.spawnSync(["fake-rewritten"], { stdout: "pipe", stderr: "pipe", env: process.env });
		expect(result.stdout.toString().trim()).toBe("second");
	});
});

describe("writeFakeCli — {scope: 'suite'} called once at describe scope", () => {
	pathBeforeSuiteScopeBlock = process.env.PATH;
	const dir = tempDir();
	writeFakeCli(dir, "fake-suite-scoped", '#!/bin/sh\necho "suite-scoped fake"\nexit 0\n', { scope: "suite" });

	test("first test in the block sees the fake binary on PATH", () => {
		const result = Bun.spawnSync(["fake-suite-scoped"], { stdout: "pipe", stderr: "pipe", env: process.env });
		expect(result.stdout.toString().trim()).toBe("suite-scoped fake");
	});

	test("second test in the block still sees the fake binary on PATH (no premature afterEach unwind)", () => {
		const result = Bun.spawnSync(["fake-suite-scoped"], { stdout: "pipe", stderr: "pipe", env: process.env });
		expect(result.stdout.toString().trim()).toBe("suite-scoped fake");
	});

	test("third test: PATH still holds dir, proving cleanup is deferred to afterAll, not afterEach", () => {
		expect(process.env.PATH?.startsWith(dir)).toBe(true);
	});
});

describe("writeFakeCli — {scope: 'suite'} restores PATH after the whole block via afterAll", () => {
	test("PATH is back to its pre-suite value now that the previous describe block's afterAll has fired", () => {
		expect(process.env.PATH).toBe(pathBeforeSuiteScopeBlock);
	});
});
