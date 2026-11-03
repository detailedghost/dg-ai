/**
 * Shared helpers for the dg-skills CLI (batch-open/demo/install/launch/detect):
 * per-OS extension paths, zip extraction, and fetching the CI-built extension
 * from GitHub Releases. Platform detection (isWSL) and subprocess running
 * (run) live in @dg/common/node and are only imported here.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isWSL, run } from "@dg/common/node";
import { readCurrent } from "../install/current";
import { syncDirInPlace } from "./extension-files";

export type Target = "chrome" | "firefox";
export const REPO = "detailedghost/dg-ai";

/** Repo root: the plugin dir when installed, else four levels up from bin/utils/. */
export function repoRoot(): string {
	return (
		process.env.CLAUDE_PLUGIN_ROOT ?? resolve(import.meta.dir, "../../../..")
	);
}

type Env = Readonly<Record<string, string | undefined>>;

function homeDir(env: Env): string {
	return env.HOME || homedir();
}

/** Windows home: DG_WINDOWS_HOME when set, else %USERPROFILE% natively on win32 or resolved through cmd.exe on WSL. */
export function windowsUserProfile(env: Env = process.env): string {
	if (env.DG_WINDOWS_HOME) return env.DG_WINDOWS_HOME;
	if (process.platform === "win32") return env.USERPROFILE || homedir();
	return run("cmd.exe", ["/c", "echo", "%USERPROFILE%"]).replace(/\r/g, "");
}

/** The Linux and macOS `.dg` directory. */
export function dgDir(env: Env = process.env): string {
	return env.DG_HOME || join(homeDir(env), ".dg");
}

/** Stable per-OS dir for a target's unpacked extension. */
export function extensionDest(
	target: Target,
	env: Env = process.env,
): {
	copyPath: string;
	printPath: string;
} {
	const name = `dg-ai-extension-${target}`;
	const windowsHost = isWSL() || process.platform === "win32";
	if (windowsHost && env.DG_WINDOWS_HOME) {
		const p = join(env.DG_WINDOWS_HOME, ".dg", name);
		return { copyPath: p, printPath: p };
	}
	if (isWSL()) {
		const winDest = `${windowsUserProfile(env)}\\.dg\\${name}`;
		const copyPath = run("wslpath", ["-u", winDest]);
		return { copyPath, printPath: run("wslpath", ["-w", copyPath]) };
	}
	if (process.platform === "win32") {
		const p = join(windowsUserProfile(env), ".dg", name);
		return { copyPath: p, printPath: p };
	}
	const p = join(dgDir(env), name);
	return { copyPath: p, printPath: p };
}

/** The `.dg` directories that may hold extension folders: the Windows one on WSL and win32, plus the Linux home. */
export function extensionDgDirs(env: Env = process.env): string[] {
	const own = dgDir(env);
	if (!isWSL() && process.platform !== "win32") return [own];
	return [...new Set([dirname(extensionDest("chrome", env).copyPath), own])];
}

/** Extract a .zip into destDir in place. bsdtar on Windows, unzip elsewhere. */
export function extractZip(zip: string, destDir: string): void {
	const staging = mkdtempSync(join(tmpdir(), "dg-ext-unzip-"));
	try {
		if (process.platform === "win32") run("tar", ["-xf", zip, "-C", staging]);
		else run("unzip", ["-oq", zip, "-d", staging]);
		syncDirInPlace(staging, destDir);
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

interface MarkerFiles {
	current: string;
	legacy: string;
}

export function markerFiles(env: Env = process.env): MarkerFiles {
	const dir = join(homeDir(env), ".config", "dg");
	return {
		current: join(dir, "extension-installed"),
		legacy: join(dir, "browser-batch-installed"),
	};
}

// Installed version per target, e.g. { "chrome": "1.0.0", "firefox": "1.0.0" }.
type Marker = Record<string, string>;

function readMarkerFile(path: string): Marker {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Marker;
	} catch {
		return {};
	}
}

export function readMarker(files: MarkerFiles = markerFiles()): Marker {
	return { ...readMarkerFile(files.legacy), ...readMarkerFile(files.current) };
}

export function writeMarkerEntry(
	target: string,
	version: string,
	files: MarkerFiles = markerFiles(),
): void {
	const m = readMarker(files);
	m[target] = version;
	mkdirSync(dirname(files.current), { recursive: true });
	writeFileSync(files.current, `${JSON.stringify(m)}\n`);
}

/** Order dotted numeric versions; a leading v and non-numeric parts count as zero. */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) =>
		v
			.replace(/^v/, "")
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const [x, y] = [parts(a), parts(b)];
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const diff = (x[i] ?? 0) - (y[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function versionGte(a: string, b: string): boolean {
	return compareVersions(a, b) >= 0;
}

export type Release = {
	tag_name: string;
	draft: boolean;
	assets: { name: string; browser_download_url: string }[];
};

export type PickedAsset = { name: string; url: string; version: string };

export type PickedBundle = {
	version: string;
	assetName: string;
	url: string;
	sumsUrl: string;
};

export const UA = { "User-Agent": "dg-ai-extension" };

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;
const LAST_PREFIXED_VERSION = "1.21.1";

/**
 * The exact `v<version>` release when `version` pins one, else the newest `vX.Y.Z` release by semver.
 * Pins at or below 1.21.1 also match `<legacyPrefix><version>`, the per-part tags used before one-tag releases.
 */
export function pickRelease(
	releases: Release[],
	version?: string,
	legacyPrefix?: string,
): Release | undefined {
	const live = releases.filter((r) => !r.draft);
	if (!version) {
		return live
			.filter((r) => RELEASE_TAG.test(r.tag_name))
			.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
	}
	const exact = live.find((r) => r.tag_name === `v${version}`);
	if (exact || !legacyPrefix || !versionGte(LAST_PREFIXED_VERSION, version)) return exact;
	return live.find((r) => r.tag_name === `${legacyPrefix}${version}`);
}

function releaseVersion(tag: string): string {
	return tag.replace(/^[a-z]+-v|^v/, "");
}

/** The legacy tag prefix of a binary: dg-skills -> skills-v. */
function legacyPrefixOf(partName: string): string {
	return `${partName.replace(/^dg-/, "")}-v`;
}

/** Extension zip for `target` from the pinned or newest release. */
export function pickExtAsset(
	releases: Release[],
	target: Target,
	version?: string,
): PickedAsset | undefined {
	const rel = pickRelease(releases, version, legacyPrefixOf("ext"));
	const asset = rel?.assets.find((a) => a.name.endsWith(`-${target}.zip`));
	if (!rel || !asset) return undefined;
	return {
		name: asset.name,
		url: asset.browser_download_url,
		version: releaseVersion(rel.tag_name),
	};
}

/** The dg-lib bundle and its SHA256SUMS from the pinned or newest vX.Y.Z release, which must also ship runtime.json. */
export function pickBundle(releases: Release[], version?: string): PickedBundle {
	const rel = pickRelease(releases, version);
	if (!rel) {
		throw new Error(
			version
				? `no release named v${version} found`
				: `no vX.Y.Z release was found in the ${releases.length} releases scanned`,
		);
	}
	const found = releaseVersion(rel.tag_name);
	const assetName = `dg-lib-${found}.tar.gz`;
	const url = (name: string) => rel.assets.find((a) => a.name === name)?.browser_download_url;
	const [bundleUrl, sumsUrl, runtimeUrl] = [assetName, "SHA256SUMS", "runtime.json"].map(url);
	if (!bundleUrl) {
		throw new Error(
			`v${found} has no ${assetName}: releases before the dg-lib bundle ship compiled binaries; run that release's bootstrap.sh: curl -fsSL https://github.com/${REPO}/releases/download/v${found}/bootstrap.sh | sh`,
		);
	}
	if (!sumsUrl || !runtimeUrl) throw new Error(`v${found} has no SHA256SUMS or runtime.json asset`);
	return { version: found, assetName, url: bundleUrl, sumsUrl };
}

/** The hash SHA256SUMS lists for `assetName` (GNU `<hash>  <name>` or `<hash> *<name>`), lowercased. */
export function expectedSha256(sums: string, assetName: string): string | undefined {
	for (const line of sums.split(/\r?\n/)) {
		const match = /^([0-9A-Fa-f]{64})\s+\*?(.+?)\s*$/.exec(line);
		if (match && match[2] === assetName) return match[1].toLowerCase();
	}
	return undefined;
}

export function sha256Hex(buf: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

/** Checks `buf` against the hash SHA256SUMS lists for `assetName`; a missing entry or a mismatch throws. */
export async function verifyReleaseAsset(
	sumsUrl: string,
	assetName: string,
	buf: Uint8Array,
	tag: string,
): Promise<void> {
	const res = await fetch(sumsUrl, { headers: UA });
	if (!res.ok) throw new Error(`failed to download SHA256SUMS for ${tag}: HTTP ${res.status}`);
	const expected = expectedSha256(await res.text(), assetName);
	if (!expected) throw new Error(`SHA256SUMS in ${tag} has no entry for ${assetName}`);
	if (sha256Hex(buf) !== expected) throw new Error(`checksum mismatch for ${assetName} in ${tag}`);
}

export const RELEASES_PER_PAGE = 100;
export const RELEASES_PAGE_CAP = 10;

export async function listReleases(): Promise<Release[]> {
	const releases: Release[] = [];
	for (let page = 1; page <= RELEASES_PAGE_CAP; page++) {
		const res = await fetch(
			`https://api.github.com/repos/${REPO}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
			{ headers: UA },
		);
		if (!res.ok) throw new Error(`GitHub API ${res.status} listing releases`);
		const batch = (await res.json()) as Release[];
		releases.push(...batch);
		if (batch.length < RELEASES_PER_PAGE) break;
	}
	return releases;
}

/** Download the newest extension release's zip for `target`, or the exact `version` pin, to a temp file. */
export async function downloadReleaseAsset(
	target: Target,
	version?: string,
): Promise<{ zip: string; version: string }> {
	const asset = pickExtAsset(await listReleases(), target, version);
	if (!asset) {
		throw new Error(
			version ? `no ${target} extension asset found for ${version}` : `no ${target} extension asset found in any vX.Y.Z release`,
		);
	}
	const dl = await fetch(asset.url, { headers: UA });
	if (!dl.ok) throw new Error(`asset download failed: HTTP ${dl.status}`);
	const zip = join(tmpdir(), asset.name);
	writeFileSync(zip, Buffer.from(await dl.arrayBuffer()));
	return { zip, version: asset.version };
}

/** `$DG_HOME` made absolute, else `~/.dg`. Matches bootstrap.sh, bootstrap.ps1 and the skills. */
export function installRoot(env: NodeJS.ProcessEnv = process.env): string {
	return env.DG_HOME ? resolve(env.DG_HOME) : join(homedir(), ".dg");
}

export function cliBinDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(installRoot(env), "bin");
}

/** The launcher shim for a program: `<root>/bin/<name>`, `.cmd` on Windows. */
export function cliDest(binaryName: string): string {
	const name = process.platform === "win32" ? `${binaryName}.cmd` : binaryName;
	return join(cliBinDir(), name);
}

/** The bundle version `lib/current` points at, or undefined before the first bundle install. */
export function readCurrentVersion(root: string = installRoot()): string | undefined {
	return readCurrent(root, "lib");
}
