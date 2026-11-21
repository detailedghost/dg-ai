import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPILE_TARGETS, compiledAssetName } from "../build";
import { buildCompiledHost } from "./compiled-fixtures";

setDefaultTimeout(300_000);

const MB = 1024 * 1024;
const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "skills-cli", "package.json"), "utf8")) as {
	version: string;
};
const runtime = JSON.parse(readFileSync(join(import.meta.dir, "..", "runtime.json"), "utf8")) as { assets: Record<string, unknown> };

const scratch = mkdtempSync(join(tmpdir(), "dg-compiled-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(program: string, args: string[]) {
	const home = mkdtempSync(join(scratch, "home-"));
	mkdirSync(join(home, "home"));
	const proc = Bun.spawnSync([program, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env, DG_HOME: join(home, "dg"), HOME: join(home, "home"), USERPROFILE: join(home, "home") },
	});
	return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? -1 };
}

describe("compile targets", () => {
	test("cover every runtime.json platform key", () => {
		expect(Object.keys(COMPILE_TARGETS).sort()).toEqual(Object.keys(runtime.assets).sort());
	});

	test("name each asset dg-<key>, with .exe on Windows", () => {
		expect(compiledAssetName("linux-x64")).toBe("dg-linux-x64");
		expect(compiledAssetName("linux-x64-baseline")).toBe("dg-linux-x64-baseline");
		expect(compiledAssetName("windows-arm64")).toBe("dg-windows-arm64.exe");
	});
});

describe("compiled dg for this machine", () => {
	const program = buildCompiledHost();

	test("--version prints the stamped version", () => {
		const result = run(program, ["--version"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(`${version}\n`);
	});

	test("skills --version and pw --help run the skills tree", () => {
		expect(run(program, ["skills", "--version"]).stdout.trim()).toBe(version);
		const help = run(program, ["pw", "--help"]);
		expect(help.exitCode).toBe(0);
		expect(help.stdout).toContain("Usage: pw");
	});

	test("phone --help runs the agent tree and job --help runs the daemon tree", () => {
		expect(run(program, ["phone", "--help"]).stdout).toContain("phone");
		expect(run(program, ["job", "--help"]).stdout).toContain("job");
	});

	test.skipIf(process.platform === "win32")("a symlink named dg-skills exits 1 with the removed-name notice", () => {
		const link = join(scratch, "dg-skills");
		symlinkSync(program, link);
		const result = run(link, ["pw", "--help"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("dg: the dg-skills command is removed; run dg pw --help\n");
		expect(result.stdout).toBe("");
	});

	test("stays under 100 MB", () => {
		expect(statSync(program).size).toBeLessThan(100 * MB);
	});
});
