import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	fakeBunArgs,
	platformKey,
	type RuntimeAsset,
	PROGRAMS,
	RUNTIME,
	present,
	removeBootstrapDirs,
	removeBootstrapFixtures,
	runBootstrap,
	shimInvocation,
} from "../../skills-cli/__tests__/bootstrap-fixtures";
import { makeTempDir, removeTempDirs } from "./test-support";

afterEach(() => {
	removeTempDirs();
	removeBootstrapDirs();
});
afterAll(removeBootstrapFixtures);

describe("bootstrap.sh installs the pinned runtime and the release bundle", () => {
	test("a default run lays out runtime, lib, current links and shims, then ends in dg-skills install", async () => {
		const result = await runBootstrap();

		expect(result.code, result.stderr).toBe(0);
		expect(
			present(join(result.root, "data", "runtime", `bun-v${RUNTIME.version}`, "bun")),
		).toBe(true);
		expect(realpathSync(join(result.root, "data", "runtime", "current"))).toBe(
			realpathSync(join(result.root, "data", "runtime", `bun-v${RUNTIME.version}`)),
		);
		expect(present(join(result.root, "data", "lib", result.version, "dg.js"))).toBe(
			true,
		);
		expect(realpathSync(join(result.root, "data", "lib", "current"))).toBe(
			realpathSync(join(result.root, "data", "lib", result.version)),
		);
		for (const program of PROGRAMS) {
			expect(
				lstatSync(join(result.root, "bin", program)).mode & 0o111,
			).not.toBe(0);
		}
		expect(shimInvocation(result.stdout)).toBe("dg-skills install");
	});

	test("each shim runs the current bundle with its own program name first", async () => {
		const result = await runBootstrap();

		expect(result.code, result.stderr).toBe(0);
		for (const program of PROGRAMS) {
			const shim = Bun.spawnSync(
				[join(result.root, "bin", program), "probe", "two words"],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(shim.exitCode).toBe(0);
			const [entry, ...rest] = fakeBunArgs(shim.stdout.toString());
			expect(entry).toEndWith(join("lib", "current", "dg.js"));
			expect(rest).toEqual([program, "probe", "two words"]);
		}
	});

	test("a second run over an existing install succeeds and keeps the links valid", async () => {
		const first = await runBootstrap();
		const second = await runBootstrap({ dgHome: first.root });

		expect(second.code, second.stderr).toBe(0);
		expect(realpathSync(join(first.root, "data", "lib", "current"))).toBe(
			realpathSync(join(first.root, "data", "lib", first.version)),
		);
		expect(realpathSync(join(first.root, "data", "runtime", "current"))).toBe(
			realpathSync(join(first.root, "data", "runtime", `bun-v${RUNTIME.version}`)),
		);
	});

	test("it resolves the newest vX.Y.Z release and downloads the bundle and runtime pin from that tag", async () => {
		const result = await runBootstrap();
		const downloads = result.requests.filter((url) =>
			url.includes("/releases/download/"),
		);

		expect(downloads).toContain(
			`https://github.com/o/r/releases/download/v${result.version}/dg-lib-${result.version}.tar.gz`,
		);
		expect(
			downloads.some((url) => url.endsWith(`/v${result.version}/runtime.json`)),
		).toBe(true);
		expect(
			downloads.some((url) => url.endsWith(`/v${result.version}/SHA256SUMS`)),
		).toBe(true);
	});

	test("it runs when piped to sh, with no script file on disk", async () => {
		const result = await runBootstrap({ piped: true });

		expect(result.code, result.stderr).toBe(0);
		expect(shimInvocation(result.stdout)).toBe("dg-skills install");
	});
});

describe("bootstrap.sh uses the per-OS layout", () => {
	test("a Linux run without DG_HOME writes the launchers to ~/.local/bin and the bundle to ~/.local/share/dg", async () => {
		const result = await runBootstrap({ withoutDgHome: true });

		expect(result.code, result.stderr).toBe(0);
		const data = join(result.home, ".local", "share", "dg");
		for (const program of PROGRAMS) {
			const shim = readFileSync(join(result.home, ".local", "bin", program), "utf8");
			expect(shim).toContain(join(data, "lib", "current", "dg.js"));
		}
		expect(realpathSync(join(data, "lib", "current"))).toBe(realpathSync(join(data, "lib", result.version)));
		expect(present(join(result.home, ".dg"))).toBe(false);
		expect(result.stdout).toContain(`export PATH="${join(result.home, ".local", "bin")}:$PATH"`);
	});

	test("a macOS run without DG_HOME writes the launchers to ~/.local/bin and the bundle to Application Support", async () => {
		const result = await runBootstrap({ withoutDgHome: true, os: "Darwin", arch: "arm64" });

		expect(result.code, result.stderr).toBe(0);
		const data = join(result.home, "Library", "Application Support", "dg");
		expect(readFileSync(join(result.home, ".local", "bin", "dg-skills"), "utf8")).toContain(
			`"${join(data, "lib", "current", "dg.js")}"`,
		);
		expect(present(join(data, "runtime", "current"))).toBe(true);
	});

	test("a DG_HOME run writes the launchers to <DG_HOME>/bin and the bundle to <DG_HOME>/data", async () => {
		const result = await runBootstrap();

		expect(result.code, result.stderr).toBe(0);
		expect(readFileSync(join(result.root, "bin", "dg-skills"), "utf8")).toContain(
			join(result.root, "data", "lib", "current", "dg.js"),
		);
		expect(present(join(result.home, ".local"))).toBe(false);
	});
});

describe("bootstrap.sh picks the bun asset from uname and the cpu flags", () => {
	const cases: {
		name: string;
		os: "Linux" | "Darwin";
		arch: string;
		avx2: boolean;
	}[] = [
		{ name: "linux x86_64 with avx2", os: "Linux", arch: "x86_64", avx2: true },
		{ name: "linux aarch64", os: "Linux", arch: "aarch64", avx2: false },
		{ name: "darwin x86_64", os: "Darwin", arch: "x86_64", avx2: true },
		{ name: "darwin arm64", os: "Darwin", arch: "arm64", avx2: false },
	];

	for (const { name, os, arch, avx2 } of cases) {
		test(`${name} downloads exactly its runtime.json asset from oven-sh`, async () => {
			const result = await runBootstrap({ os, arch, avx2 });
			const expected = (
				RUNTIME.assets[platformKey(os, arch, avx2)] as RuntimeAsset
			).file;

			expect(result.code, result.stderr).toBe(0);
			expect(result.bunZipRequests).toEqual([
				`https://github.com/oven-sh/bun/releases/download/bun-v${RUNTIME.version}/${expected}`,
			]);
		});
	}

	test("Contract: picks bun-linux-x64-baseline.zip when the cpu flags lack avx2", async () => {
		const result = await runBootstrap({
			os: "Linux",
			arch: "x86_64",
			avx2: false,
		});

		expect(result.code, result.stderr).toBe(0);
		expect(RUNTIME.assets["linux-x64-baseline"]?.file).toBe(
			"bun-linux-x64-baseline.zip",
		);
		expect(result.bunZipRequests.map((url) => url.split("/").pop())).toEqual([
			"bun-linux-x64-baseline.zip",
		]);
	});
});

describe("bootstrap.sh verifies every download before it installs", () => {
	test("Contract: exits 1 with 'checksum mismatch' when the bun zip hash differs and leaves no runtime/current", async () => {
		const result = await runBootstrap({ zipHashMismatch: true });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("checksum mismatch");
		expect(present(join(result.root, "data", "runtime", "current"))).toBe(false);
		expect(result.stdout).not.toContain("FAKE_BUN");
	});

	test("Contract: exits 1 when dg-lib-<v>.tar.gz is absent from SHA256SUMS", async () => {
		const result = await runBootstrap({ sums: "without-lib" });

		expect(result.code).toBe(1);
		expect(present(join(result.root, "data", "lib", "current"))).toBe(false);
		expect(result.stdout).not.toContain("FAKE_BUN");
	});

	test("a runtime.json that does not match SHA256SUMS exits 1 before any bun download", async () => {
		const result = await runBootstrap({ sums: "wrong-runtime" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("checksum mismatch");
		expect(result.bunZipRequests).toEqual([]);
		expect(present(join(result.root, "data", "runtime", "current"))).toBe(false);
	});

	test("a wrong tarball hash exits 1 with 'checksum mismatch' and leaves no lib/current", async () => {
		const result = await runBootstrap({ sums: "wrong-lib" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("checksum mismatch");
		expect(present(join(result.root, "data", "lib", "current"))).toBe(false);
		expect(result.stdout).not.toContain("FAKE_BUN");
	});
});

describe("bootstrap.sh ends by invoking the shim with the install flags of its mode", () => {
	const modes: {
		name: string;
		args: string[];
		env?: Record<string, string>;
		install: string;
	}[] = [
		{ name: "default", args: [], install: "install" },
		{ name: "--cli-only", args: ["--cli-only"], install: "install --cli-only" },
		{
			name: "--agent-only",
			args: ["--agent-only"],
			install: "install --agent-only",
		},
		{
			name: "DG_CLI_ONLY=1",
			args: [],
			env: { DG_CLI_ONLY: "1" },
			install: "install --cli-only",
		},
	];

	for (const { name, args, env, install } of modes) {
		test(`${name} runs dg-skills ${install}`, async () => {
			const result = await runBootstrap({ args, env });

			expect(result.code, result.stderr).toBe(0);
			expect(shimInvocation(result.stdout)).toBe(`dg-skills ${install}`);
		});
	}

	test("--skills-only copies the skill files, installs the runtime, bundle and shims, and runs no dg-skills install", async () => {
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
		expect(realpathSync(join(result.root, "data", "lib", "current"))).toBe(
			realpathSync(join(result.root, "data", "lib", result.version)),
		);
		for (const program of PROGRAMS) expect(present(join(result.root, "bin", program))).toBe(true);
		expect(result.installCall).toBeUndefined();
		expect(result.stdout.indexOf("Installed 1 skill files")).toBeLessThan(
			result.stdout.indexOf("Downloading"),
		);
	});

	test("--version <x.y.z> installs that release, ignores a newer one and runs dg-skills install --version", async () => {
		const result = await runBootstrap({
			version: "1.26.0",
			args: ["--version", "1.26.0"],
			newerEmptyRelease: true,
		});

		expect(result.code, result.stderr).toBe(0);
		expect(present(join(result.root, "data", "lib", "1.26.0", "dg.js"))).toBe(true);
		expect(realpathSync(join(result.root, "data", "lib", "current"))).toBe(
			realpathSync(join(result.root, "data", "lib", "1.26.0")),
		);
		expect(shimInvocation(result.stdout)).toBe(
			"dg-skills install --version 1.26.0",
		);
	});

	test("--version=<x.y.z> behaves like the two-word form", async () => {
		const result = await runBootstrap({
			version: "1.26.0",
			args: ["--version=1.26.0"],
		});

		expect(result.code, result.stderr).toBe(0);
		expect(shimInvocation(result.stdout)).toBe(
			"dg-skills install --version 1.26.0",
		);
	});

	test("two conflicting mode flags exit 1 before any download", async () => {
		const result = await runBootstrap({ args: ["--cli-only", "--agent-only"] });

		expect(result.code).toBe(1);
		expect(result.requests).toEqual([]);
	});
});

describe("bootstrap.sh retires the compiled dg-skills, dg-agent and dg-daemon binaries", () => {
	const OLD_BINARY = "OLD COMPILED BINARY";

	test("each old binary becomes a shim for its own name and loses its version stamp", async () => {
		const result = await runBootstrap({
			seed: (root) => {
				mkdirSync(join(root, "bin"), { recursive: true });
				for (const program of PROGRAMS) {
					writeFileSync(join(root, "bin", program), OLD_BINARY);
					chmodSync(join(root, "bin", program), 0o755);
					writeFileSync(join(root, "bin", `.${program}.version`), "1.0.0\n");
				}
			},
		});

		expect(result.code, result.stderr).toBe(0);
		for (const program of PROGRAMS) {
			const shim = readFileSync(join(result.root, "bin", program), "utf8");
			expect(shim).not.toContain(OLD_BINARY);
			expect(shim).toContain(program);
			expect(present(join(result.root, "bin", `.${program}.version`))).toBe(false);
		}
	});
});
