import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

function run(program: string, args: string[], cwd?: string) {
	const home = mkdtempSync(join(scratch, "home-"));
	mkdirSync(join(home, "home"));
	const proc = Bun.spawnSync([program, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		cwd,
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
	let program = "";
	beforeAll(() => {
		program = buildCompiledHost();
	}, 300_000);

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
		for (const [command, usage] of [["phone", "Usage: dg agent phone"], ["job", "Usage: dg daemon job"]] as const) {
			const help = run(program, [command, "--help"]);
			expect(help.exitCode).toBe(0);
			expect(help.stdout).toContain(usage);
		}
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

	test("runs no preload from a bunfig.toml in the working directory", () => {
		const cwd = mkdtempSync(join(scratch, "cwd-"));
		const marker = join(cwd, "preload-ran");
		writeFileSync(join(cwd, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\n`);
		writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
		expect(run(program, ["--version"], cwd).exitCode).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	test("loads no .env from the working directory", () => {
		const cwd = mkdtempSync(join(scratch, "cwd-"));
		writeFileSync(join(cwd, ".env"), `DG_HOME=${join(cwd, "from-dotenv")}\n`);
		const env: Record<string, string | undefined> = { ...process.env, HOME: cwd, USERPROFILE: cwd };
		delete env.DG_HOME;
		const proc = Bun.spawnSync([program, "config", "path"], { cwd, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).not.toContain("from-dotenv");
		expect(proc.stdout.toString().startsWith(cwd)).toBe(true);
	});
});
