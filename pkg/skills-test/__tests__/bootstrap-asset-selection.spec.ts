import { afterEach, describe, expect, test } from "bun:test";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	assetName,
	LEGACY_PROGRAMS,
	PLATFORMS,
	platformKey,
	present,
	programRun,
	removeBootstrapDirs,
	runBootstrap,
} from "../../skills-cli/__tests__/bootstrap-fixtures";
import { makeTempDir, readRepoFile, removeTempDirs } from "./test-support";

afterEach(() => {
	removeTempDirs();
	removeBootstrapDirs();
});

describe("bootstrap.sh installs the compiled dg program", () => {
	test("a default run stages bin/<version>/dg, links bin/current and ${BIN}/dg, then ends in dg install", async () => {
		const result = await runBootstrap();
		const binDir = join(result.root, "data", "bin");

		expect(result.code, result.stderr).toBe(0);
		expect(lstatSync(join(binDir, result.version, "dg")).mode & 0o777).toBe(0o755);
		expect(readlinkSync(join(binDir, "current"))).toBe(result.version);
		expect(readlinkSync(join(result.root, "bin", "dg"))).toBe(
			join(result.root, "data", "bin", "current", "dg"),
		);
		expect(readdirSync(binDir).sort()).toEqual([result.version, "current"]);
		expect(programRun(result.stdout)).toEqual({
			asset: "dg-linux-x64",
			env: "1",
			args: ["install"],
		});
		expect(result.stdout).toContain(
			`dg ${result.version} installed at ${join(result.root, "data", "bin", result.version)}`,
		);
	});

	test("it downloads SHA256SUMS and the one asset, and no runtime.json, Bun zip or dg-lib tarball", async () => {
		const result = await runBootstrap();
		const downloads = result.requests.filter((url) => url.includes("/download/"));

		expect(downloads.map((url) => url.split("/").pop()).sort()).toEqual([
			"SHA256SUMS",
			"dg-linux-x64",
		]);
		expect(downloads.every((url) => url.includes(`/v${result.version}/`))).toBe(true);
	});

	test("a second run over the same version downloads no asset and keeps the links", async () => {
		const first = await runBootstrap();
		const second = await runBootstrap({ dgHome: first.root });

		expect(second.code, second.stderr).toBe(0);
		expect(second.assetRequests).toEqual([]);
		expect(second.requests.filter((url) => url.includes("/download/"))).toEqual([]);
		expect(realpathSync(join(first.root, "data", "bin", "current"))).toBe(
			realpathSync(join(first.root, "data", "bin", first.version)),
		);
		expect(programRun(second.stdout)?.args).toEqual(["install"]);
	});

	test("it runs when piped to sh, with no script file on disk", async () => {
		const result = await runBootstrap({ piped: true });

		expect(result.code, result.stderr).toBe(0);
		expect(result.installCall).toBe("install");
	});

	test("it needs neither tar nor unzip for a normal install", () => {
		const script = readRepoFile("pkg", "skills-cli", "bootstrap.sh");
		const start = script.indexOf('ASSET="dg-${platform}"');

		expect(start).toBeGreaterThan(-1);
		expect(script.slice(start)).not.toMatch(/\b(unzip|tar -)/);
	});
});

describe("bootstrap.sh uses the per-OS layout", () => {
	test("a Linux run without DG_HOME links ~/.local/bin/dg to ~/.local/share/dg/bin/current/dg", async () => {
		const result = await runBootstrap({ withoutDgHome: true });

		expect(result.code, result.stderr).toBe(0);
		const data = join(result.home, ".local", "share", "dg");
		expect(readlinkSync(join(result.home, ".local", "bin", "dg"))).toBe(
			join(data, "bin", "current", "dg"),
		);
		expect(readlinkSync(join(data, "bin", "current"))).toBe(result.version);
		expect(present(join(result.home, ".dg"))).toBe(false);
		expect(result.stdout).toContain(`export PATH="${join(result.home, ".local", "bin")}:$PATH"`);
	});

	test("a Linux run ignores a relative XDG_DATA_HOME", async () => {
		const result = await runBootstrap({ withoutDgHome: true, env: { XDG_DATA_HOME: "rel-data" } });

		expect(result.code, result.stderr).toBe(0);
		expect(present(join(result.home, ".local", "share", "dg", "bin", result.version, "dg"))).toBe(true);
	});

	test("a macOS run without DG_HOME uses Application Support for the program", async () => {
		const result = await runBootstrap({ withoutDgHome: true, os: "Darwin", arch: "arm64" });

		expect(result.code, result.stderr).toBe(0);
		const data = join(result.home, "Library", "Application Support", "dg");
		expect(readlinkSync(join(result.home, ".local", "bin", "dg"))).toBe(
			join(data, "bin", "current", "dg"),
		);
		expect(programRun(result.stdout)?.asset).toBe("dg-darwin-arm64");
	});

	test("a DG_HOME run writes <DG_HOME>/bin and <DG_HOME>/data and nothing under HOME", async () => {
		const result = await runBootstrap();

		expect(result.code, result.stderr).toBe(0);
		expect(readdirSync(join(result.root, "bin"))).toEqual(["dg"]);
		expect(present(join(result.home, ".local"))).toBe(false);
	});
});

describe("bootstrap.sh picks the asset from uname and the cpu flags", () => {
	const cases: {
		key: (typeof PLATFORMS)[number];
		os: "Linux" | "Darwin";
		arch: string;
		avx2: boolean;
	}[] = [
		{ key: "linux-x64", os: "Linux", arch: "x86_64", avx2: true },
		{ key: "linux-x64-baseline", os: "Linux", arch: "x86_64", avx2: false },
		{ key: "linux-arm64", os: "Linux", arch: "aarch64", avx2: false },
		{ key: "darwin-x64", os: "Darwin", arch: "x86_64", avx2: true },
		{ key: "darwin-arm64", os: "Darwin", arch: "arm64", avx2: false },
	];

	for (const { key, os, arch, avx2 } of cases) {
		test(`${key} downloads exactly dg-${key} and runs that program`, async () => {
			const result = await runBootstrap({ os, arch, avx2 });

			expect(result.code, result.stderr).toBe(0);
			expect(platformKey(os, arch, avx2)).toBe(key);
			expect(result.assetRequests).toEqual([
				`https://github.com/o/r/releases/download/v${result.version}/dg-${key}`,
			]);
			expect(programRun(result.stdout)?.asset).toBe(`dg-${key}`);
		});
	}

	for (const { key, os, arch, avx2 } of cases) {
		test(`${key} with a gzip asset downloads exactly dg-${key}.gz`, async () => {
			const result = await runBootstrap({ os, arch, avx2, gz: "valid" });

			expect(result.code, result.stderr).toBe(0);
			expect(result.assetRequests).toEqual([
				`https://github.com/o/r/releases/download/v${result.version}/dg-${key}.gz`,
			]);
			expect(programRun(result.stdout)?.asset).toBe(`dg-${key}`);
		});
	}

	test("the release asset names are the eight the release workflow publishes", () => {
		expect(PLATFORMS.map(assetName)).toEqual([
			"dg-linux-x64",
			"dg-linux-x64-baseline",
			"dg-linux-arm64",
			"dg-darwin-x64",
			"dg-darwin-arm64",
			"dg-windows-x64.exe",
			"dg-windows-x64-baseline.exe",
			"dg-windows-arm64.exe",
		]);
	});
});

describe("bootstrap.ps1 picks the asset", () => {
	const ps1 = readRepoFile("pkg", "skills-cli", "bootstrap.ps1");

	test("the platform is windows-x64, windows-x64-baseline without AVX2, or windows-arm64, and the asset adds .exe", () => {
		expect(ps1).toContain('$platform = "windows-$arch"');
		expect(ps1).toContain('$platform = "windows-x64-baseline"');
		expect(ps1).toContain("Test-DgAvx2");
		expect(ps1).toContain('"arm64" } else { "x64" }');
		expect(ps1).toContain('$asset = "dg-$platform.exe"');
	});

	test("it prefers the .gz asset, reads it with GZipStream and falls back to the raw asset", () => {
		expect(ps1).toContain("function Select-DgAsset");
		expect(ps1).toContain('"$Raw.gz"');
		expect(ps1).toContain("System.IO.Compression.GZipStream");
		expect(ps1).toContain("Assert-DgSha256 $downloaded $asset $expected");
	});

	test("it downloads no runtime.json, Bun zip or dg-lib tarball", () => {
		expect(ps1).not.toContain("runtime.json");
		expect(ps1).not.toContain("dg-lib-");
		expect(ps1).not.toContain("bun.exe");
	});
});

describe("bootstrap.sh verifies the asset before it installs", () => {
	test("a checksum mismatch exits 1 and changes nothing", async () => {
		const result = await runBootstrap({ sums: "wrong-asset" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("dg: checksum mismatch for dg-linux-x64");
		expect(present(join(result.root, "data", "bin", "current"))).toBe(false);
		expect(present(join(result.root, "bin", "dg"))).toBe(false);
		expect(programRun(result.stdout)).toBeUndefined();
		expect(readdirSync(join(result.root, "data", "bin"))).toEqual([]);
	});

	test("an asset missing from SHA256SUMS exits 1 and changes nothing", async () => {
		const result = await runBootstrap({ sums: "without-asset" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("has no entry for dg-linux-x64");
		expect(result.assetRequests).toEqual([]);
		expect(present(join(result.root, "data", "bin", "current"))).toBe(false);
		expect(present(join(result.root, "bin", "dg"))).toBe(false);
	});
});

describe("bootstrap.sh ends by invoking dg with the install flags of its mode", () => {
	const modes: {
		name: string;
		args: string[];
		env?: Record<string, string>;
		install: string;
	}[] = [
		{ name: "default", args: [], install: "install" },
		{ name: "--cli-only", args: ["--cli-only"], install: "install --cli-only" },
		{ name: "--agent-only", args: ["--agent-only"], install: "install --agent-only" },
		{
			name: "DG_CLI_ONLY=1",
			args: [],
			env: { DG_CLI_ONLY: "1" },
			install: "install --cli-only",
		},
	];

	for (const { name, args, env, install } of modes) {
		test(`${name} runs dg ${install}`, async () => {
			const result = await runBootstrap({ args, env });

			expect(result.code, result.stderr).toBe(0);
			expect(result.installCall).toBe(install);
		});
	}

	test("--skills-only copies the skill files, installs the dg program and runs no dg install", async () => {
		const source = makeTempDir("dg-bootstrap-skills-src-");
		mkdirSync(join(source, "demo"), { recursive: true });
		writeFileSync(join(source, "demo", "SKILL.md"), "---\nname: demo\n---\n");
		const dest = makeTempDir("dg-bootstrap-skills-dest-");

		const result = await runBootstrap({
			args: ["--skills-only"],
			env: { DG_SKILLS_SOURCE: source, DG_SKILLS_DEST: dest },
		});

		expect(result.code, result.stderr).toBe(0);
		expect(readFileSync(join(dest, "demo", "SKILL.md"), "utf8")).toContain("name: demo");
		expect(realpathSync(join(result.root, "data", "bin", "current"))).toBe(
			realpathSync(join(result.root, "data", "bin", result.version)),
		);
		expect(present(join(result.root, "bin", "dg"))).toBe(true);
		for (const old of LEGACY_PROGRAMS) expect(present(join(result.root, "bin", old))).toBe(false);
		expect(result.installCall).toBeUndefined();
		expect(result.stdout.indexOf("Installed 1 skill files")).toBeLessThan(
			result.stdout.indexOf("Downloading"),
		);
	});

	test("--version <x.y.z> installs that release, ignores a newer one and runs dg install --version", async () => {
		const result = await runBootstrap({
			version: "1.26.0",
			args: ["--version", "1.26.0"],
			newerEmptyRelease: true,
		});

		expect(result.code, result.stderr).toBe(0);
		expect(present(join(result.root, "data", "bin", "1.26.0", "dg"))).toBe(true);
		expect(readlinkSync(join(result.root, "data", "bin", "current"))).toBe("1.26.0");
		expect(result.installCall).toBe("install --version 1.26.0");
	});

	test("--version=<x.y.z> behaves like the two-word form", async () => {
		const result = await runBootstrap({
			version: "1.26.0",
			args: ["--version=1.26.0"],
		});

		expect(result.code, result.stderr).toBe(0);
		expect(result.installCall).toBe("install --version 1.26.0");
	});

	test("two conflicting mode flags exit 1 before any download", async () => {
		const result = await runBootstrap({ args: ["--cli-only", "--agent-only"] });

		expect(result.code).toBe(1);
		expect(result.requests).toEqual([]);
	});
});
