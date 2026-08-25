import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile, runInHarness } from "./test-support";

const install = readRepoFile(
	"pkg",
	"skills-cli",
	"src",
	"commands",
	"install.ts",
);

describe("install retires the pre-rename daemon binary", () => {
	test("dg-server is listed as retired and dg-daemon is not", () => {
		const listed = /const RETIRED_BINARIES = \[([^\]]*)\]/.exec(install)?.[1];

		expect(listed).toContain('"dg-server"');
		expect(listed).not.toContain('"dg-daemon"');
		expect(listed).not.toContain('"dg-skills"');
	});

	test("the removal runs after the refresh, so a fetch failure cannot strand the machine binaryless", () => {
		const body = install.slice(install.indexOf("async function installCli"));

		expect(body.indexOf("installBinary(spec, releases)")).toBeLessThan(
			body.indexOf("removeRetiredBinaries()"),
		);
	});

	test("it clears the version stamp too, so a later install does not think it is current", async () => {
		const home = mkdtempSync(join(tmpdir(), "dg-retired-binaries-test-"));
		const binDir = join(home, ".dg", "bin");
		mkdirSync(binDir, { recursive: true });
		const serverBin = join(binDir, "dg-server");
		const serverVersion = join(binDir, ".dg-server.version");
		writeFileSync(serverBin, "old-dg-server-binary");
		writeFileSync(serverVersion, "1.2.3\n");

		const installPath = join(
			REPO_ROOT,
			"pkg",
			"skills-cli",
			"src",
			"commands",
			"install.ts",
		);
		const { code, stderr } = await runInHarness(
			`const mod = await import(${JSON.stringify(installPath)});\nmod.removeRetiredBinaries();\n`,
			{ HOME: home },
		);

		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(existsSync(serverBin)).toBe(false);
		expect(existsSync(serverVersion)).toBe(false);
	});
});
