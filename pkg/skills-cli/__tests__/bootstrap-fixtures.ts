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
import { fenceEnv } from "./fence-env";

export const BOOTSTRAP = join(import.meta.dir, "..", "bootstrap.sh");
export const LEGACY_PROGRAMS = ["dg-skills", "dg-agent", "dg-daemon"] as const;
export const RELEASE_VERSION = "1.27.0";

export const PLATFORMS = [
	"linux-x64",
	"linux-x64-baseline",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"windows-x64",
	"windows-x64-baseline",
	"windows-arm64",
] as const;

export function assetName(platform: string): string {
	return platform.startsWith("windows") ? `dg-${platform}.exe` : `dg-${platform}`;
}

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

function fakeProgram(
	asset: string,
	reported: string,
	broken: boolean,
): string {
	return `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  ${broken ? "exit 1" : `printf '%s (fake)\\n' "${reported}"; exit 0`}
fi
printf 'FAKE_DG %s\\n' "${asset}"
printf 'FAKE_ENV %s\\n' "\${DG_SKILLS_BOOTSTRAP:-}"
for arg in "$@"; do printf 'FAKE_ARG %s\\n' "$arg"; done
`;
}

export type ProgramRun = { asset: string; env: string; args: string[] };

export function programRun(stdout: string): ProgramRun | undefined {
	const lines = stdout.split("\n");
	const asset = lines.find((line) => line.startsWith("FAKE_DG "));
	if (asset === undefined) return undefined;
	const env = lines.find((line) => line.startsWith("FAKE_ENV ")) ?? "";
	return {
		asset: asset.slice("FAKE_DG ".length),
		env: env.slice("FAKE_ENV ".length),
		args: lines
			.filter((line) => line.startsWith("FAKE_ARG "))
			.map((line) => line.slice("FAKE_ARG ".length)),
	};
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
	"DG_GZIP",
	"XDG_DATA_HOME",
];

export function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

const runDirs: string[] = [];

/** Removes the per-run directories that runBootstrap created. */
export function removeBootstrapDirs(): void {
	for (const dir of runDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
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
	sums?: "complete" | "without-asset" | "wrong-asset";
	assetVersion?: string;
	assetBroken?: boolean;
	newerEmptyRelease?: boolean;
	gz?: "none" | "valid" | "corrupt" | "wrong-content";
	withoutGzip?: boolean;
	piped?: boolean;
	script?: string;
	cwd?: string;
	serve?: Record<string, string>;
	/** Extra release assets: name to the sha256 that SHA256SUMS lists for it (null leaves it out of SHA256SUMS). */
	extraAssets?: Record<string, string | null>;
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
	assetRequests: string[];
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

	const assetFiles: string[] = [];
	const lines = [
		`${sha256("sh")}  bootstrap.sh`,
		`${sha256("ps1")}  bootstrap.ps1`,
	];
	for (const platform of PLATFORMS) {
		const file = assetName(platform);
		const body = fakeProgram(
			file,
			options.assetVersion ?? version,
			options.assetBroken === true,
		);
		writeFileSync(join(serve, file), body);
		assetFiles.push(file);
		const mine = file === assetName(platformKey(os, arch, avx2));
		lines.push(
			`${options.sums === "wrong-asset" && mine ? "0".repeat(64) : sha256(body)}  ${file}`,
		);
		const gzMode = options.gz ?? "none";
		if (gzMode !== "none") {
			const packed =
				gzMode === "corrupt"
					? Buffer.from("not gzip data")
					: Buffer.from(Bun.gzipSync(gzMode === "wrong-content" ? `${body}tampered\n` : body));
			writeFileSync(join(serve, `${file}.gz`), packed);
			assetFiles.push(`${file}.gz`);
			lines.push(`${sha256(packed)}  ${file}.gz`);
		}
	}
	for (const [name, source] of Object.entries(options.serve ?? {})) {
		symlinkSync(source, join(serve, name));
	}
	writeFileSync(join(serve, "runtime.json"), "{}");
	writeFileSync(join(serve, `dg-lib-${version}.tar.gz`), "lib");
	lines.push(`${sha256("{}")}  runtime.json`, `${sha256("lib")}  dg-lib-${version}.tar.gz`);
	for (const [name, hash] of Object.entries(options.extraAssets ?? {}))
		if (hash !== null) lines.push(`${hash}  ${name}`);
	const listed =
		options.sums === "without-asset"
			? lines.filter((line) => !line.endsWith(`  ${assetName(platformKey(os, arch, avx2))}`))
			: lines;
	writeFileSync(join(serve, "SHA256SUMS"), `${listed.join("\n")}\n`);

	const assets = [
		...assetFiles,
		`dg-lib-${version}.tar.gz`,
		"runtime.json",
		"SHA256SUMS",
		"bootstrap.sh",
		"bootstrap.ps1",
		...Object.keys(options.extraAssets ?? {}),
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
			...fenceEnv(),
			HOME: join(dir, "home"),
			...(options.withoutDgHome ? {} : { DG_HOME: root }),
			DG_CURL: curl,
			DG_UNAME: uname,
			STUBDIR: dir,
			STUB_OS: os,
			STUB_ARCH: arch,
			DG_CPUINFO_FILE: cpuinfo,
			...(options.withoutGzip ? { DG_GZIP: join(dir, "no-such-gzip") } : {}),
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
		assetRequests: requests.filter((url) => /\/dg-(linux|darwin|windows)-/.test(url)),
		installCall: programRun(stdout)?.args.join(" "),
	};
}
