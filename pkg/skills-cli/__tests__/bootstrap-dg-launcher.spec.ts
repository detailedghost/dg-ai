import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDgLauncher } from "../src/install/shims";
import {
	BOOTSTRAP,
	LEGACY_PROGRAMS,
	PROGRAMS,
	removeBootstrapDirs,
	removeBootstrapFixtures,
	runBootstrap,
} from "./bootstrap-fixtures";
import {
	isReplacedLauncher,
	KEPT_SENTENCE,
	launcherFixtures,
	type Snapshot,
	snapshot,
} from "./dg-launcher-fixtures";

const BOOTSTRAP_PS1 = join(import.meta.dir, "..", "bootstrap.ps1");
const sh = readFileSync(BOOTSTRAP, "utf8");
const ps1 = readFileSync(BOOTSTRAP_PS1, "utf8");
const posix = describe.skipIf(process.platform === "win32");
const unwrapped = (text: string): string => text.replace(/\n#\s*/g, " ");
const SENTENCE_TAIL =
	"; it is not a dg launcher. Remove it or rename it, then run dg-skills install again";

afterEach(removeBootstrapDirs);
afterAll(removeBootstrapFixtures);

function shLoop(): string {
	const start = sh.indexOf("for program in dg-skills dg-agent dg-daemon dg");
	if (start < 0) return "";
	return sh.slice(start, sh.indexOf("\ndone", start));
}

function ps1Loop(): string {
	const start = ps1.indexOf("foreach ($program in");
	if (start < 0) return "";
	return ps1.slice(start, ps1.indexOf('Write-Host "dg runtime', start));
}

describe("bootstrap.sh program loop", () => {
	test("lists dg after dg-daemon", () => {
		expect(shLoop()).not.toBe("");
	});

	test("tests the dg file with [ -L ], [ -d ] and grep -qF before mktemp and mv -f", () => {
		const loop = shLoop();
		const test = loop.indexOf("grep -qF");

		expect(loop).toContain("[ -L");
		expect(loop).toContain("[ -d");
		expect(test).toBeGreaterThan(-1);
		expect(test).toBeLessThan(loop.indexOf("mktemp"));
		expect(test).toBeLessThan(loop.indexOf("mv -f"));
	});

	test("holds the kept sentence as its own literal", () => {
		expect(sh).toContain(`dg: kept `);
		expect(sh).toContain(SENTENCE_TAIL);
	});

	test("names the four launchers in its header comment", () => {
		expect(unwrapped(sh)).toContain("the dg, dg-skills, dg-agent and dg-daemon launchers");
	});
});

describe("bootstrap.ps1 program loop", () => {
	test("lists dg after dg-daemon and writes a dg.cmd with the form of the other .cmd launchers", () => {
		const loop = ps1Loop();

		expect(loop).toMatch(/@\("dg-skills", "dg-agent", "dg-daemon", "dg"\)/);
		expect(loop).toContain(
			'"@echo off`r`n`"$dgHome\\runtime\\current\\bun.exe`" `"$dgHome\\lib\\current\\dg.js`" $program %*`r`n"',
		);
		expect(loop).toContain('"$program.cmd"');
	});

	test("tests only the first 4096 bytes of the dg.cmd for the marker, before WriteAllText", () => {
		const loop = ps1Loop();
		const check = "GetString([byte[]]$head).Contains('lib\\current\\dg.js')";

		expect(loop).toContain("Select-Object -First 4096");
		expect(loop).toContain(check);
		expect(loop).not.toContain("Select-String -LiteralPath $item.FullName");
		expect(loop.indexOf(check)).toBeLessThan(loop.indexOf("WriteAllText"));
	});

	test("holds the kept sentence as its own literal", () => {
		expect(ps1).toContain("dg: kept ");
		expect(ps1).toContain(SENTENCE_TAIL);
	});

	test("never names dg.exe", () => {
		expect(ps1Loop()).not.toContain('"dg.exe"');
	});

	test("names the four launchers in its header comment", () => {
		expect(unwrapped(ps1)).toContain(
			"the dg, dg-skills, dg-agent and dg-daemon launchers",
		);
	});
});

posix("bootstrap.sh writes the launchers", () => {
	test("leaves exactly dg, dg-agent, dg-daemon and dg-skills in the bin folder, and dg --version prints the release version", async () => {
		const result = await runBootstrap();
		const bin = join(result.root, "bin");

		expect(result.code, result.stderr).toBe(0);
		expect(readdirSync(bin).sort()).toEqual([...PROGRAMS].sort());
		const run = Bun.spawnSync([join(bin, "dg"), "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(run.stdout.toString().trim()).toBe(result.version);
	});

	test("all four launchers print the same version", async () => {
		const result = await runBootstrap();

		const versions = PROGRAMS.map((name) =>
			Bun.spawnSync([join(result.root, "bin", name), "--version"], {
				stdout: "pipe",
			})
				.stdout.toString()
				.trim(),
		);
		expect(new Set(versions)).toEqual(new Set([result.version]));
	});

	test("the dg launcher it writes is a dg launcher for the install rule, though its bytes differ from the writeShims template", async () => {
		const result = await runBootstrap();

		expect(isDgLauncher(join(result.root, "bin", "dg"), "linux")).toBe(true);
		expect(readFileSync(join(result.root, "bin", "dg"), "utf8")).toContain(
			"lib/current/dg.js",
		);
	});

	test("leaves a .dg.version file alone and removes the stamps of the three legacy names", async () => {
		const result = await runBootstrap({
			seed: (root) => {
				mkdirSync(join(root, "bin"), { recursive: true });
				for (const name of ["dg", ...LEGACY_PROGRAMS])
					writeFileSync(join(root, "bin", `.${name}.version`), "1.0.0\n");
			},
		});

		expect(result.code, result.stderr).toBe(0);
		expect(existsSync(join(result.root, "bin", ".dg.version"))).toBe(true);
		for (const name of LEGACY_PROGRAMS)
			expect(existsSync(join(result.root, "bin", `.${name}.version`))).toBe(
				false,
			);
	});

	for (const [flag, args] of [
		["--cli-only", ["--cli-only"]],
		["--agent-only", ["--agent-only"]],
	] as const) {
		test(`${flag} writes the same four launchers`, async () => {
			const result = await runBootstrap({ args: [...args] });

			expect(result.code, result.stderr).toBe(0);
			expect(readdirSync(join(result.root, "bin")).sort()).toEqual(
				[...PROGRAMS].sort(),
			);
		});
	}

	test("--skills-only writes the same four launchers", async () => {
		const source = mkdtempSync(join(tmpdir(), "dg-dg-launcher-src-"));
		const dest = mkdtempSync(join(tmpdir(), "dg-dg-launcher-dest-"));
		try {
			mkdirSync(join(source, "demo"));
			writeFileSync(join(source, "demo", "SKILL.md"), "---\nname: demo\n---\n");

			const result = await runBootstrap({
				args: ["--skills-only"],
				env: { DG_SKILLS_SOURCE: source, DG_SKILLS_DEST: dest },
			});

			expect(result.code, result.stderr).toBe(0);
			expect(readdirSync(join(result.root, "bin")).sort()).toEqual(
				[...PROGRAMS].sort(),
			);
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(dest, { recursive: true, force: true });
		}
	});
});

posix("bootstrap.sh with a dg path that holds something else", () => {
	for (const fixture of launcherFixtures("linux")) {
		test.skipIf(fixture.skip === true)(
			`${fixture.outcome === "kept" ? "keeps" : "replaces"} ${fixture.name}`,
			async () => {
				let before: Snapshot | undefined;
				let targets: Snapshot[] = [];
				let untouched: string[] = [];
				const result = await runBootstrap({
					seed: (root, dir) => {
						const dest = join(root, "bin", "dg");
						untouched = fixture.setup(dest, join(dir, "fixture-area"));
						before = snapshot(dest);
						targets = untouched.map((path) => snapshot(path));
					},
				});
				const dest = join(result.root, "bin", "dg");

				expect(result.code, result.stderr).toBe(0);
				expect(untouched.map((path) => snapshot(path))).toEqual(targets);
				for (const name of LEGACY_PROGRAMS)
					expect(isDgLauncher(join(result.root, "bin", name), "linux")).toBe(
						true,
					);
				if (fixture.outcome === "kept") {
					expect(snapshot(dest)).toEqual(before as Snapshot);
					expect(result.stderr).toContain(KEPT_SENTENCE(dest));
				} else {
					expect(isReplacedLauncher(dest, "linux")).toBe(true);
					expect(result.stderr).not.toContain("is not a dg launcher");
				}
			},
			30_000,
		);
	}
});

describe.skipIf(Bun.which("pwsh") === null)(
	"bootstrap.ps1 program loop run under pwsh (skipped when pwsh is absent)",
	() => {
		for (const fixture of launcherFixtures("win32")) {
			test.skipIf(fixture.skip === true)(
				`${fixture.outcome === "kept" ? "keeps" : "replaces"} ${fixture.name}`,
				() => {
					const area = mkdtempSync(join(tmpdir(), "dg-ps1-launcher-"));
					try {
						const bin = join(area, "bin");
						mkdirSync(bin, { recursive: true });
						const dest = join(bin, "dg.cmd");
						fixture.setup(dest, join(area, "fixture-area"));
						const before = snapshot(dest);
						const script = join(area, "run.ps1");
						writeFileSync(
							script,
							`$dgHome = '${join(area, "data")}'\n$binDir = '${bin}'\n${ps1Loop()}\n`,
						);

						const run = Bun.spawnSync(["pwsh", "-NoProfile", "-File", script], {
							stdout: "pipe",
							stderr: "pipe",
						});
						const output = run.stdout.toString() + run.stderr.toString();

						expect(run.exitCode, output).toBe(0);
						for (const name of LEGACY_PROGRAMS)
							expect(existsSync(join(bin, `${name}.cmd`))).toBe(true);
						if (fixture.outcome === "kept") {
							expect(snapshot(dest)).toEqual(before);
							expect(output).toContain(KEPT_SENTENCE(dest));
						} else {
							expect(isReplacedLauncher(dest, "win32")).toBe(true);
						}
					} finally {
						rmSync(area, { recursive: true, force: true });
					}
				},
			);
		}

		test("leaves a dg.exe with the same bytes and removes the exe of the three legacy names", () => {
			const area = mkdtempSync(join(tmpdir(), "dg-ps1-exe-"));
			try {
				const bin = join(area, "bin");
				mkdirSync(bin, { recursive: true });
				writeFileSync(join(bin, "dg.exe"), "MZ other tool");
				for (const name of LEGACY_PROGRAMS)
					writeFileSync(join(bin, `${name}.exe`), "MZ compiled");
				const script = join(area, "run.ps1");
				writeFileSync(
					script,
					`$dgHome = '${join(area, "data")}'\n$binDir = '${bin}'\n${ps1Loop()}\n`,
				);

				const run = Bun.spawnSync(["pwsh", "-NoProfile", "-File", script], {
					stdout: "pipe",
					stderr: "pipe",
				});

				expect(run.exitCode, run.stderr.toString()).toBe(0);
				expect(readFileSync(join(bin, "dg.exe"), "utf8")).toBe("MZ other tool");
				for (const name of LEGACY_PROGRAMS)
					expect(existsSync(join(bin, `${name}.exe`))).toBe(false);
			} finally {
				rmSync(area, { recursive: true, force: true });
			}
		});
	},
);
