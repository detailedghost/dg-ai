import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	programRun,
	removeBootstrapDirs,
	runBootstrap,
} from "./bootstrap-fixtures";

const sh = readFileSync(join(import.meta.dir, "..", "bootstrap.sh"), "utf8");
const ps1 = readFileSync(join(import.meta.dir, "..", "bootstrap.ps1"), "utf8");
type Snapshot = { type: string; mode: number; bytes: string | undefined; link: string | undefined };

function snapshot(path: string): Snapshot {
	const stat = lstatSync(path);
	const type = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFIFO() ? "fifo" : "file";
	let bytes: string | undefined;
	if (type === "file") {
		try {
			bytes = readFileSync(path).toString("base64");
		} catch {
			bytes = undefined;
		}
	}
	return { type, mode: stat.mode, bytes, link: type === "link" ? readlinkSync(path) : undefined };
}

const posix = describe.skipIf(process.platform === "win32");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const KEPT = (path: string): string =>
	`dg: kept ${path}; it is not a dg launcher. Remove it or rename it, then run the bootstrap again`;
const OLD_SHIM = (root: string, program = "dg"): string =>
	`#!/bin/sh\nexec "${root}/runtime/current/bun" "${root}/lib/current/dg.js" ${program} "$@"\n`;

afterEach(removeBootstrapDirs);

type Fixture = {
	name: string;
	outcome: "kept" | "replaced";
	skip?: boolean;
	setup: (dest: string, root: string, area: string) => void;
};

const put = (path: string, body: string | Uint8Array, mode = 0o755): void => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	chmodSync(path, mode);
};

const FIXTURES: Fixture[] = [
	{
		name: "a link to a file that is not a dg launcher",
		outcome: "kept",
		setup(dest, _root, area) {
			put(join(area, "foreign", "tool"), "#!/bin/sh\necho other tool\n");
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(join(area, "foreign", "tool"), dest);
		},
	},
	{
		name: "a directory",
		outcome: "kept",
		setup: (dest) => mkdirSync(dest, { recursive: true }),
	},
	{
		name: "an empty file",
		outcome: "kept",
		setup: (dest) => put(dest, ""),
	},
	{
		name: "a file that cannot be read",
		outcome: "kept",
		skip: isRoot,
		setup: (dest, root) => put(dest, OLD_SHIM(root), 0o000),
	},
	{
		name: 'a script that runs exec dg-skills "$@"',
		outcome: "kept",
		setup: (dest) => put(dest, '#!/bin/sh\nexec dg-skills "$@"\n'),
	},
	{
		name: "a file with a NUL byte that holds the shim text",
		outcome: "kept",
		setup: (dest, root) =>
			put(dest, Buffer.concat([Buffer.from([0]), Buffer.from(OLD_SHIM(root))])),
	},
	{
		name: "a FIFO",
		outcome: "kept",
		setup(dest) {
			mkdirSync(dirname(dest), { recursive: true });
			const made = Bun.spawnSync(["mkfifo", dest]);
			if (made.exitCode !== 0) throw new Error(made.stderr.toString());
		},
	},
	{
		name: "a link with no target",
		outcome: "replaced",
		setup(dest, _root, area) {
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(join(area, "nowhere"), dest);
		},
	},
	{
		name: "a link into the data dir bin folder",
		outcome: "replaced",
		setup(dest, root) {
			put(join(root, "bin", "1.0.0", "dg"), "#!/bin/sh\n");
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(join(root, "bin", "1.0.0", "dg"), dest);
		},
	},
	{
		name: "a 6.3 shim",
		outcome: "replaced",
		setup: (dest, root) => put(dest, OLD_SHIM(root)),
	},
	{
		name: "a 6.3 shim of another root with an added line",
		outcome: "replaced",
		setup: (dest, _root, area) => put(dest, `${OLD_SHIM(area)}# local tweak\n`),
	},
	{
		name: "a copy of the dg-skills shim named dg",
		outcome: "replaced",
		setup: (dest, root) => put(dest, OLD_SHIM(root, "dg-skills")),
	},
	{
		name: "a link to a 6.3 shim",
		outcome: "replaced",
		setup(dest, root, area) {
			put(join(area, "real", "dg"), OLD_SHIM(root));
			mkdirSync(dirname(dest), { recursive: true });
			symlinkSync(join(area, "real", "dg"), dest);
		},
	},
];

posix("bootstrap.sh with a dg path that holds something else", () => {
	for (const fixture of FIXTURES) {
		test.skipIf(fixture.skip === true)(
			`${fixture.outcome === "kept" ? "keeps" : "replaces"} ${fixture.name}`,
			async () => {
				let before: Snapshot | undefined;
				const result = await runBootstrap({
					seed: (root, dir) => {
						const dest = join(root, "bin", "dg");
						fixture.setup(dest, join(root, "data"), join(dir, "fixture-area"));
						before = snapshot(dest);
					},
				});
				const dest = join(result.root, "bin", "dg");

				expect(result.code, result.stderr).toBe(0);
				if (fixture.outcome === "kept") {
					expect(snapshot(dest)).toEqual(before as Snapshot);
					expect(result.stderr).toContain(KEPT(dest));
					expect(programRun(result.stdout)?.args).toEqual(["install"]);
				} else {
					expect(lstatSync(dest).isSymbolicLink()).toBe(true);
					expect(readlinkSync(dest)).toBe(
						join(result.root, "data", "bin", "current", "dg"),
					);
					expect(result.stderr).not.toContain("is not a dg launcher");
				}
			},
			30_000,
		);
	}

	test("a link to a foreign file leaves the file it pointed at alone", async () => {
		let target = "";
		const result = await runBootstrap({
			seed: (root, dir) => {
				target = join(dir, "other-tool");
				put(target, "#!/bin/sh\necho mine\n");
				mkdirSync(join(root, "bin"), { recursive: true });
				symlinkSync(join(root, "data", "bin", "1.0.0", "dg"), join(root, "bin", "dg"));
				symlinkSync(target, join(root, "bin", "dg-skills"));
			},
		});

		expect(result.code, result.stderr).toBe(0);
		expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho mine\n");
		expect(lstatSync(join(result.root, "bin", "dg-skills")).isSymbolicLink()).toBe(true);
		expect(result.stderr).toContain(join(result.root, "bin", "dg-skills"));
	});
});

describe("bootstrap.sh text", () => {
	test("holds the kept sentence as its own literal", () => {
		expect(sh).toContain("dg: kept ${BIN}/dg; it is not a dg launcher.");
		expect(sh).toContain("Remove it or rename it, then run the bootstrap again");
	});

	test("tests the dg path before it makes the link", () => {
		const linkTest = sh.indexOf("is_dg_launcher \"${BIN}/dg\"");
		const link = sh.indexOf('link_current "${BIN}/dg"');

		expect(linkTest).toBeGreaterThan(-1);
		expect(linkTest).toBeLessThan(link);
		expect(sh).toContain("[ -L");
		expect(sh).toContain("grep -qF 'lib/current/dg.js'");
	});

	test("writes no file named dg-skills, dg-agent or dg-daemon", () => {
		const code = sh.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");

		expect(code).not.toMatch(/printf .*exec/);
		expect(code).not.toContain("mktemp \"${BIN}");
		expect(code).toContain("for old in dg-skills dg-agent dg-daemon; do");
	});

	test("names the compiled program in its header comment", () => {
		expect(sh.replace(/\n#\s*/g, " ")).toContain("bin/<release>/dg and a bin/current link");
	});
});

describe("bootstrap.ps1 text", () => {
	test("links dg.exe by hard link after it renames the old one aside", () => {
		const aside = ps1.indexOf('".dg.exe." +');
		const rename = ps1.indexOf("Rename-Item -LiteralPath $dgExe");
		const link = ps1.indexOf("New-Item -ItemType HardLink -Path $dgExe -Target $program");

		expect(aside).toBeGreaterThan(-1);
		expect(rename).toBeGreaterThan(aside);
		expect(link).toBeGreaterThan(rename);
		expect(ps1).toContain('-Filter ".dg.exe.*.old"');
		expect(ps1).toContain('".old"');
	});

	test("keeps a dg.exe whose SHA256 matches no bin\\<x.y.z>\\dg.exe and runs bin\\current\\dg.exe instead", () => {
		const hash = ps1.indexOf("$have = Get-DgSha256 $dgExe");
		const compare = ps1.indexOf("(Get-DgSha256 $candidate) -eq $have");
		const kept = ps1.indexOf("dg: kept $dgExe; it is not a dg launcher. Remove it or rename it, then run the bootstrap again");
		const rename = ps1.indexOf("Rename-Item -LiteralPath $dgExe");

		expect(hash).toBeGreaterThan(-1);
		expect(compare).toBeGreaterThan(hash);
		expect(kept).toBeGreaterThan(compare);
		expect(rename).toBeGreaterThan(kept);
		expect(ps1).toContain('$dgRun = Join-Path $dgHome "bin\\current\\dg.exe"');
	});

	test("runs the staged program for its version before the junction and the link change", () => {
		const version = ps1.indexOf("& $staged --version");
		const check = ps1.indexOf("if ($first -ne $releaseVersion)");
		const move = ps1.indexOf("Move-Item -LiteralPath $stage -Destination $versionDir");
		const junction = ps1.indexOf('Set-DgJunction (Join-Path $dgHome "bin\\current") $versionDir');
		const link = ps1.indexOf("New-Item -ItemType HardLink");

		expect(version).toBeGreaterThan(-1);
		expect(check).toBeGreaterThan(version);
		expect(move).toBeGreaterThan(check);
		expect(junction).toBeGreaterThan(move);
		expect(link).toBeGreaterThan(junction);
	});

	test("removes dg.cmd and the three old launchers only when they are dg launchers, and their version stamps", () => {
		expect(ps1).toContain('$oldDgCmd = Join-Path $binDir "dg.cmd"');
		expect(ps1).toContain("Test-DgLauncher $oldDgCmd");
		expect(ps1).toContain('foreach ($old in @("dg-skills", "dg-agent", "dg-daemon"))');
		expect(ps1).toContain('foreach ($ext in @(".cmd", ".exe"))');
		expect(ps1).toContain("Test-DgLauncher $path");
		expect(ps1).toContain("dg: kept $path; it is not a dg launcher");
		expect(ps1).toContain('".$old.version"');
		expect(ps1).toContain("Contains('lib\\current\\dg.js')");
		expect(ps1).toContain("$stream.Read($buffer, 0, 4096)");
		expect(ps1).not.toContain("ReadAllBytes");
	});

	test("writes no .cmd launcher and names no old program in a message", () => {
		expect(ps1).not.toContain("@echo off");
		expect(ps1).not.toContain("dg-skills install");
		expect(ps1).not.toContain("dg-skills:");
	});

	test("runs dg.exe install with the bootstrap marker", () => {
		expect(ps1).toContain('$env:DG_SKILLS_BOOTSTRAP = "1"');
		expect(ps1).toContain("& $dgRun @installArgs");
	});

	test("names the compiled program in its header comment", () => {
		expect(ps1.replace(/\n#\s*/g, " ")).toContain("bin\\<release>\\dg.exe and a bin\\current junction");
	});
});
