import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT, makeTempDir, readRepoFile, removeTempDirs } from "./test-support";

afterEach(removeTempDirs);

const BOOTSTRAP = join(REPO_ROOT, "pkg", "skills-cli", "bootstrap.sh");
const PROGRAMS = ["dg-skills", "dg-agent", "dg-daemon"] as const;
const RELEASE_VERSION = "1.27.0";

type RuntimeAsset = { file: string; sha256: string };
type RuntimeJson = { version: string; assets: Record<string, RuntimeAsset> };

const RUNTIME = JSON.parse(
	readRepoFile("pkg", "launcher", "runtime.json"),
) as RuntimeJson;

const CURL_STUB = `#!/bin/sh
outfile=""
prev=""
url=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then outfile="$a"; fi
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done
printf '%s\\n' "$url" >> "$STUBDIR/requests.log"
emit() {
  if [ -n "$outfile" ] && [ "$outfile" != "-" ]; then cat "$1" > "$outfile"; else cat "$1"; fi
}
case "$url" in
*/releases\\?*page=[2-9]*)
  printf '[]'
  ;;
*/releases\\?*)
  emit "$STUBDIR/releases.json"
  ;;
*)
  f="$STUBDIR/serve/$(basename "$url")"
  if [ ! -f "$f" ]; then
    echo "stub: no fixture for $url" >&2
    exit 22
  fi
  emit "$f"
  ;;
esac
`;

const UNAME_STUB = `#!/bin/sh
case "\${1:-}" in
  -m) printf '%s\\n' "$STUB_ARCH" ;;
  *) printf '%s\\n' "$STUB_OS" ;;
esac
`;

const FAKE_BUN = `#!/bin/sh
printf 'FAKE_BUN %s\\n' "$*"
`;

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function run(cmd: string[], cwd?: string): void {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0)
		throw new Error(`${cmd.join(" ")}: ${result.stderr.toString()}`);
}

type Fixtures = {
	zips: Map<string, { path: string; sha256: string }>;
};

let fixtures: Fixtures | undefined;
let zipsDir: string | undefined;

afterAll(() => {
	if (zipsDir) rmSync(zipsDir, { recursive: true, force: true });
});

function bunZips(): Fixtures {
	if (fixtures) return fixtures;
	const dir = mkdtempSync(join(tmpdir(), "dg-bootstrap-zips-"));
	zipsDir = dir;
	const zips = new Map<string, { path: string; sha256: string }>();
	for (const { file } of Object.values(RUNTIME.assets)) {
		const inner = file.replace(/\.zip$/, "");
		const stage = join(dir, `stage-${inner}`);
		mkdirSync(join(stage, inner), { recursive: true });
		writeFileSync(join(stage, inner, "bun"), FAKE_BUN);
		chmodSync(join(stage, inner, "bun"), 0o755);
		const path = join(dir, file);
		run(["zip", "-q", "-r", path, inner], stage);
		zips.set(file, { path, sha256: sha256(readFileSync(path)) });
	}
	fixtures = { zips };
	return fixtures;
}

function buildLibTarball(
	dir: string,
	version: string,
): { path: string; sha256: string } {
	const stage = join(dir, "lib-stage");
	mkdirSync(join(stage, "chunks"), { recursive: true });
	writeFileSync(join(stage, "dg.js"), "export {};\n");
	writeFileSync(join(stage, "chunks", "main-abcd1234.js"), "export {};\n");
	const path = join(dir, "serve", `dg-lib-${version}.tar.gz`);
	run(["tar", "-czf", path, "-C", stage, "dg.js", "chunks"]);
	return { path, sha256: sha256(readFileSync(path)) };
}

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function release(tag: string, assets: string[]): Record<string, unknown> {
	return {
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: assets.map((name) => ({
			name,
			browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}`,
		})),
	};
}

type BootstrapOptions = {
	version?: string;
	os?: "Linux" | "Darwin";
	arch?: string;
	avx2?: boolean;
	args?: string[];
	env?: Record<string, string>;
	dgHome?: string;
	zipHashMismatch?: boolean;
	sums?: "complete" | "without-lib" | "wrong-lib" | "wrong-runtime";
	newerEmptyRelease?: boolean;
	piped?: boolean;
	seed?: (root: string) => void;
};

type BootstrapRun = {
	code: number;
	stdout: string;
	stderr: string;
	root: string;
	version: string;
	requests: string[];
	bunZipRequests: string[];
};

function platformKey(os: string, arch: string, avx2: boolean): string {
	const family = os === "Darwin" ? "darwin" : "linux";
	const cpu = arch === "x86_64" ? "x64" : "arm64";
	return family === "linux" && cpu === "x64" && !avx2
		? "linux-x64-baseline"
		: `${family}-${cpu}`;
}

async function runBootstrap(
	options: BootstrapOptions = {},
): Promise<BootstrapRun> {
	const version = options.version ?? RELEASE_VERSION;
	const os = options.os ?? "Linux";
	const arch = options.arch ?? "x86_64";
	const avx2 = options.avx2 ?? true;
	const dir = makeTempDir("dg-bootstrap-test-");
	const binDir = join(dir, "stubbin");
	const serve = join(dir, "serve");
	for (const path of [binDir, serve, join(dir, "home")])
		mkdirSync(path, { recursive: true });
	for (const [name, body] of [
		["curl", CURL_STUB],
		["uname", UNAME_STUB],
	] as const) {
		writeFileSync(join(binDir, name), body);
		chmodSync(join(binDir, name), 0o755);
	}

	const { zips } = bunZips();
	const expectedFile = (
		RUNTIME.assets[platformKey(os, arch, avx2)] as RuntimeAsset
	).file;
	const served: Record<string, RuntimeAsset> = {};
	for (const [key, asset] of Object.entries(RUNTIME.assets)) {
		const zip = zips.get(asset.file) as { path: string; sha256: string };
		symlinkSync(zip.path, join(serve, asset.file));
		const forged = options.zipHashMismatch && asset.file === expectedFile;
		served[key] = {
			file: asset.file,
			sha256: forged ? "0".repeat(64) : zip.sha256,
		};
	}
	const runtimeJson = JSON.stringify({ version: RUNTIME.version, assets: served });
	writeFileSync(join(serve, "runtime.json"), runtimeJson);

	const tarball = buildLibTarball(dir, version);
	const lines = [
		`${sha256("sh")}  bootstrap.sh`,
		`${sha256("ps1")}  bootstrap.ps1`,
		`${options.sums === "wrong-runtime" ? "0".repeat(64) : sha256(runtimeJson)}  runtime.json`,
	];
	if (options.sums !== "without-lib") {
		lines.push(
			`${options.sums === "wrong-lib" ? "0".repeat(64) : tarball.sha256}  dg-lib-${version}.tar.gz`,
		);
	}
	writeFileSync(join(serve, "SHA256SUMS"), `${lines.join("\n")}\n`);

	const assets = [
		`dg-lib-${version}.tar.gz`,
		"runtime.json",
		"SHA256SUMS",
		"bootstrap.sh",
		"bootstrap.ps1",
	];
	const releases = [
		...(options.newerEmptyRelease ? [release("v9.0.0", [])] : []),
		release("ext-v9.5.0", []),
		release(`v${version}`, assets),
		release("v1.0.0", []),
	];
	writeFileSync(join(dir, "releases.json"), JSON.stringify(releases));

	const cpuinfo = join(dir, "cpuinfo");
	writeFileSync(
		cpuinfo,
		`flags\t\t: fpu sse sse2 sse4_2 avx${avx2 ? " avx2" : ""} popcnt\n`,
	);

	const root = options.dgHome ?? join(dir, "dgroot");
	options.seed?.(root);
	const script = readFileSync(BOOTSTRAP);
	const argv = options.piped
		? ["sh", "-s", "--", ...(options.args ?? [])]
		: ["sh", BOOTSTRAP, ...(options.args ?? [])];
	const proc = Bun.spawn(argv, {
		stdin: options.piped ? "pipe" : "ignore",
		cwd: dir,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
			HOME: join(dir, "home"),
			DG_HOME: root,
			STUBDIR: dir,
			STUB_OS: os,
			STUB_ARCH: arch,
			DG_CPUINFO_FILE: cpuinfo,
			...(options.env ?? {}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (options.piped && proc.stdin) {
		proc.stdin.write(script);
		proc.stdin.end();
	}
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	const requestsLog = join(dir, "requests.log");
	const requests = present(requestsLog)
		? readFileSync(requestsLog, "utf8").split("\n").filter(Boolean)
		: [];
	return {
		code,
		stdout,
		stderr,
		root,
		version,
		requests,
		bunZipRequests: requests.filter((url) => /\/bun-[^/]+\.zip$/.test(url)),
	};
}

function shimInvocation(stdout: string): string | undefined {
	const line = stdout
		.split("\n")
		.find((entry) => entry.startsWith("FAKE_BUN "));
	return line?.replace(/^FAKE_BUN \S*dg\.js /, "");
}

describe("bootstrap.sh installs the pinned runtime and the release bundle", () => {
	test("a default run lays out runtime, lib, current links and shims, then ends in dg-skills install", async () => {
		const result = await runBootstrap();

		expect(result.code, result.stderr).toBe(0);
		expect(
			present(join(result.root, "runtime", `bun-v${RUNTIME.version}`, "bun")),
		).toBe(true);
		expect(realpathSync(join(result.root, "runtime", "current"))).toBe(
			realpathSync(join(result.root, "runtime", `bun-v${RUNTIME.version}`)),
		);
		expect(present(join(result.root, "lib", result.version, "dg.js"))).toBe(
			true,
		);
		expect(realpathSync(join(result.root, "lib", "current"))).toBe(
			realpathSync(join(result.root, "lib", result.version)),
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
			expect(shim.stdout.toString().trim()).toEndWith(
				`${join("lib", "current", "dg.js")} ${program} probe two words`,
			);
		}
	});

	test("a second run over an existing install succeeds and keeps the links valid", async () => {
		const first = await runBootstrap();
		const second = await runBootstrap({ dgHome: first.root });

		expect(second.code, second.stderr).toBe(0);
		expect(realpathSync(join(first.root, "lib", "current"))).toBe(
			realpathSync(join(first.root, "lib", first.version)),
		);
		expect(realpathSync(join(first.root, "runtime", "current"))).toBe(
			realpathSync(join(first.root, "runtime", `bun-v${RUNTIME.version}`)),
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
		expect(present(join(result.root, "runtime", "current"))).toBe(false);
		expect(result.stdout).not.toContain("FAKE_BUN");
	});

	test("Contract: exits 1 when dg-lib-<v>.tar.gz is absent from SHA256SUMS", async () => {
		const result = await runBootstrap({ sums: "without-lib" });

		expect(result.code).toBe(1);
		expect(present(join(result.root, "lib", "current"))).toBe(false);
		expect(result.stdout).not.toContain("FAKE_BUN");
	});

	test("a runtime.json that does not match SHA256SUMS exits 1 before any bun download", async () => {
		const result = await runBootstrap({ sums: "wrong-runtime" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("checksum mismatch");
		expect(result.bunZipRequests).toEqual([]);
		expect(present(join(result.root, "runtime", "current"))).toBe(false);
	});

	test("a wrong tarball hash exits 1 with 'checksum mismatch' and leaves no lib/current", async () => {
		const result = await runBootstrap({ sums: "wrong-lib" });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("checksum mismatch");
		expect(present(join(result.root, "lib", "current"))).toBe(false);
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
			name: "--skills-only",
			args: ["--skills-only"],
			install: "install --skills-only",
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

	test("--version <x.y.z> installs that release, ignores a newer one and runs dg-skills install --version", async () => {
		const result = await runBootstrap({
			version: "1.26.0",
			args: ["--version", "1.26.0"],
			newerEmptyRelease: true,
		});

		expect(result.code, result.stderr).toBe(0);
		expect(present(join(result.root, "lib", "1.26.0", "dg.js"))).toBe(true);
		expect(realpathSync(join(result.root, "lib", "current"))).toBe(
			realpathSync(join(result.root, "lib", "1.26.0")),
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
