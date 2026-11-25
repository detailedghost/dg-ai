import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	present,
	programRun,
	removeBootstrapDirs,
	runBootstrap,
} from "./bootstrap-fixtures";

const posix = describe.skipIf(process.platform === "win32");

afterEach(removeBootstrapDirs);

posix("bootstrap.sh reads the gzip asset", () => {
	test("it downloads dg-<key>.gz and not the raw asset, then runs the unpacked program", async () => {
		const result = await runBootstrap({ gz: "valid" });

		expect(result.code, result.stderr).toBe(0);
		expect(result.assetRequests).toEqual([
			`https://github.com/o/r/releases/download/v${result.version}/dg-linux-x64.gz`,
		]);
		expect(programRun(result.stdout)?.asset).toBe("dg-linux-x64");
		expect(result.stdout).toContain("Downloading dg-linux-x64.gz...");
	});

	test("the installed dg is the decompressed program and reports the release version", async () => {
		const result = await runBootstrap({ gz: "valid" });
		const run = Bun.spawnSync([join(result.root, "bin", "dg"), "--version"], {
			stdout: "pipe",
		});

		expect(run.stdout.toString().split(" ")[0]).toBe(result.version);
	});

	test("the checksum applies to the decompressed bytes: a .gz that unpacks to other bytes exits 1 and changes nothing", async () => {
		const result = await runBootstrap({ gz: "wrong-content" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("dg: checksum mismatch for dg-linux-x64");
		expect(present(join(result.root, "data", "bin", "current"))).toBe(false);
		expect(present(join(result.root, "bin", "dg"))).toBe(false);
	});

	test("a corrupt .gz exits 1 and changes nothing", async () => {
		const result = await runBootstrap({ gz: "corrupt" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("dg: could not unpack dg-linux-x64.gz");
		expect(present(join(result.root, "data", "bin", "current"))).toBe(false);
	});

	test("a release without a .gz asset installs from the raw asset", async () => {
		const result = await runBootstrap({ gz: "none" });

		expect(result.code, result.stderr).toBe(0);
		expect(result.assetRequests).toEqual([
			`https://github.com/o/r/releases/download/v${result.version}/dg-linux-x64`,
		]);
	});

	test("a machine without gzip installs from the raw asset", async () => {
		const result = await runBootstrap({ gz: "valid", withoutGzip: true });

		expect(result.code, result.stderr).toBe(0);
		expect(result.assetRequests).toEqual([
			`https://github.com/o/r/releases/download/v${result.version}/dg-linux-x64`,
		]);
	});

	test("a missing raw SHA256SUMS entry exits 1 before any asset download, even with a .gz", async () => {
		const result = await runBootstrap({ gz: "valid", sums: "without-asset" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("has no entry for dg-linux-x64");
		expect(result.assetRequests).toEqual([]);
	});
});
