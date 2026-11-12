import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const BOOTSTRAP = join(import.meta.dir, "..", "bootstrap.sh");
export const PROGRAMS = ["dg-skills", "dg-agent", "dg-daemon"] as const;
export const RELEASE_VERSION = "1.27.0";

export type RuntimeAsset = { file: string; sha256: string };
type RuntimeJson = { version: string; assets: Record<string, RuntimeAsset> };

export const RUNTIME = JSON.parse(
	readFileSync(
		join(import.meta.dir, "..", "..", "launcher", "runtime.json"),
		"utf8",
	),
) as RuntimeJson;

const CURL_SEAM = `#!/bin/sh
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

const UNAME_SEAM = `#!/bin/sh
case "\${1:-}" in
  -m) printf '%s\\n' "$STUB_ARCH" ;;
  *) printf '%s\\n' "$STUB_OS" ;;
esac
`;

export const FAKE_BUN = `#!/bin/sh
printf 'FAKE_BUN %s\\n' "$*"
for arg in "$@"; do printf 'FAKE_ARG %s\\n' "$arg"; done
`;

/** Each argument the fake Bun received, one entry per argument. */
export function fakeBunArgs(stdout: string): string[] {
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("FAKE_ARG "))
		.map((line) => line.slice("FAKE_ARG ".length));
}

const ENV_OWNED_BY_BOOTSTRAP = [
	"DG_HOME",
	"DG_VERSION",
	"DG_CLI_ONLY",
	"DG_AGENT_ONLY",
	"DG_SKILLS_ONLY",
	"DG_SKILLS_NO_CLI",
	"DG_SKILLS_DEST",
	"DG_SKILLS_SOURCE",
	"DG_INSTALL_CODEX",
	"CODEX_HOME",
	"DG_CURL",
	"DG_UNAME",
	"XDG_DATA_HOME",
];

export function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function run(cmd: string[], cwd?: string): void {
	const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0)
		throw new Error(`${cmd.join(" ")}: ${result.stderr.toString()}`);
}

export function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

let zips: Map<string, { path: string; sha256: string }> | undefined;
let zipsDir: string | undefined;
const runDirs: string[] = [];

/** Removes the per-run directories that runBootstrap created. */
export function removeBootstrapDirs(): void {
	for (const dir of runDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

/** Removes the Bun zips shared by every run in this file. */
export function removeBootstrapFixtures(): void {
	removeBootstrapDirs();
	if (zipsDir) rmSync(zipsDir, { recursive: true, force: true });
	zips = undefined;
	zipsDir = undefined;
}

function bunZips(): Map<string, { path: string; sha256: string }> {
	if (zips) return zips;
	const dir = mkdtempSync(join(tmpdir(), "dg-bootstrap-zips-"));
	zipsDir = dir;
	const built = new Map<string, { path: string; sha256: string }>();
	for (const { file } of Object.values(RUNTIME.assets)) {
		const inner = file.replace(/\.zip$/, "");
		const stage = join(dir, `stage-${inner}`);
		mkdirSync(join(stage, inner), { recursive: true });
		writeFileSync(join(stage, inner, "bun"), FAKE_BUN);
		chmodSync(join(stage, inner, "bun"), 0o755);
		const path = join(dir, file);
		run(["zip", "-q", "-r", path, inner], stage);
		built.set(file, { path, sha256: sha256(readFileSync(path)) });
	}
	zips = built;
	return built;
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

export function release(
	tag: string,
	assets: string[],
): Record<string, unknown> {
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

export type BootstrapOptions = {
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
	script?: string;
	cwd?: string;
	serve?: Record<string, string>;
	seed?: (root: string, dir: string) => void;
	withoutDgHome?: boolean;
};

export type BootstrapRun = {
	code: number;
	stdout: string;
	stderr: string;
	dir: string;
	home: string;
	root: string;
	version: string;
	requests: string[];
	bunZipRequests: string[];
	installCall: string | undefined;
};

export function platformKey(os: string, arch: string, avx2: boolean): string {
	const family = os === "Darwin" ? "darwin" : "linux";
	const cpu = arch === "x86_64" ? "x64" : "arm64";
	return family === "linux" && cpu === "x64" && !avx2
		? "linux-x64-baseline"
		: `${family}-${cpu}`;
}

function writeSeam(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

/** The arguments the installed dg-skills shim received, as the fake Bun printed them. */
export function shimInvocation(stdout: string): string | undefined {
	const line = stdout
		.split("\n")
		.find((entry) => entry.startsWith("FAKE_BUN "));
	return line?.replace(/^FAKE_BUN \S*dg\.js /, "");
}

/**
 * Runs bootstrap.sh against a fake release served through the DG_CURL and DG_UNAME seams.
 * Nothing goes on PATH and nothing reaches the network.
 */
export async function runBootstrap(
	options: BootstrapOptions = {},
): Promise<BootstrapRun> {
	const version = options.version ?? RELEASE_VERSION;
	const os = options.os ?? "Linux";
	const arch = options.arch ?? "x86_64";
	const avx2 = options.avx2 ?? true;
	const dir = mkdtempSync(join(tmpdir(), "dg-bootstrap-test-"));
	runDirs.push(dir);
	const seams = join(dir, "seams");
	const serve = join(dir, "serve");
	for (const path of [seams, serve, join(dir, "home")])
		mkdirSync(path, { recursive: true });
	const curl = writeSeam(seams, "curl", CURL_SEAM);
	const uname = writeSeam(seams, "uname", UNAME_SEAM);

	const built = bunZips();
	const expectedFile = (
		RUNTIME.assets[platformKey(os, arch, avx2)] as RuntimeAsset
	).file;
	const served: Record<string, RuntimeAsset> = {};
	for (const [key, asset] of Object.entries(RUNTIME.assets)) {
		const zip = built.get(asset.file) as { path: string; sha256: string };
		symlinkSync(zip.path, join(serve, asset.file));
		const forged = options.zipHashMismatch && asset.file === expectedFile;
		served[key] = {
			file: asset.file,
			sha256: forged ? "0".repeat(64) : zip.sha256,
		};
	}
	const runtimeJson = JSON.stringify({
		version: RUNTIME.version,
		assets: served,
	});
	writeFileSync(join(serve, "runtime.json"), runtimeJson);
	for (const [name, source] of Object.entries(options.serve ?? {})) {
		symlinkSync(source, join(serve, name));
	}

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
	options.seed?.(root, dir);
	const script = options.script ?? BOOTSTRAP;
	const argv = options.piped
		? ["sh", "-s", "--", ...(options.args ?? [])]
		: ["sh", script, ...(options.args ?? [])];
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !ENV_OWNED_BY_BOOTSTRAP.includes(key))
			env[key] = value;
	}
	const proc = Bun.spawn(argv, {
		stdin: options.piped ? "pipe" : "ignore",
		cwd: options.cwd ?? dir,
		env: {
			...env,
			HOME: join(dir, "home"),
			...(options.withoutDgHome ? {} : { DG_HOME: root }),
			DG_CURL: curl,
			DG_UNAME: uname,
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
		proc.stdin.write(readFileSync(script));
		proc.stdin.end();
	}
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const requestsLog = join(dir, "requests.log");
	const requests = existsSync(requestsLog)
		? readFileSync(requestsLog, "utf8").split("\n").filter(Boolean)
		: [];
	return {
		code,
		stdout,
		stderr,
		dir,
		home: join(dir, "home"),
		root,
		version,
		requests,
		bunZipRequests: requests.filter((url) => /\/bun-[^/]+\.zip$/.test(url)),
		installCall: shimInvocation(stdout),
	};
}
