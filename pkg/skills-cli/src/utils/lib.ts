/**
 * Shared helpers for the dg-skills CLI (batch-open/demo/install/launch/detect):
 * per-OS extension paths, zip extraction, and fetching the CI-built extension
 * from GitHub Releases. Platform detection (isWSL) and subprocess running
 * (run) live in @dg/common/node and are only imported here.
 */

import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isWSL, run } from "@dg/common/node";

export type Target = "chrome" | "firefox";
export const REPO = "detailedghost/dg-ai";

/** Repo root: the plugin dir when installed, else four levels up from bin/utils/. */
export function repoRoot(): string {
	return (
		process.env.CLAUDE_PLUGIN_ROOT ?? resolve(import.meta.dir, "../../../..")
	);
}

/** Windows %USERPROFILE%, as a native path on win32 or resolved for WSL. */
export function windowsUserProfile(): string {
	if (process.platform === "win32") return process.env.USERPROFILE ?? homedir();
	return run("cmd.exe", ["/c", "echo", "%USERPROFILE%"]).replace(/\r/g, "");
}

/** Stable per-OS dir for a target's unpacked extension. */
export function extensionDest(target: Target): {
	copyPath: string;
	printPath: string;
} {
	if (isWSL()) {
		const winDest = `${windowsUserProfile()}\\.dg\\dg-ai-extension-${target}`;
		const copyPath = run("wslpath", ["-u", winDest]);
		return { copyPath, printPath: run("wslpath", ["-w", copyPath]) };
	}
	if (process.platform === "win32") {
		const p = `${windowsUserProfile()}\\.dg\\dg-ai-extension-${target}`;
		return { copyPath: p, printPath: p };
	}
	const p = join(homedir(), ".dg", `dg-ai-extension-${target}`);
	return { copyPath: p, printPath: p };
}

/** Extract a .zip into destDir (cleared first). bsdtar on Windows, unzip elsewhere. */
export function extractZip(zip: string, destDir: string): void {
	rmSync(destDir, { recursive: true, force: true });
	mkdirSync(destDir, { recursive: true });
	if (process.platform === "win32") run("tar", ["-xf", zip, "-C", destDir]);
	else run("unzip", ["-oq", zip, "-d", destDir]);
}

export const markerPath = join(
	homedir(),
	".config",
	"dg",
	"browser-batch-installed",
);

// Installed version per target, e.g. { "chrome": "1.0.0", "firefox": "1.0.0" }.
type Marker = Record<string, string>;

export function readMarker(): Marker {
	try {
		return JSON.parse(readFileSync(markerPath, "utf8")) as Marker;
	} catch {
		return {};
	}
}

export function writeMarkerEntry(target: string, version: string): void {
	const m = readMarker();
	m[target] = version;
	mkdirSync(join(homedir(), ".config", "dg"), { recursive: true });
	writeFileSync(markerPath, `${JSON.stringify(m)}\n`);
}

export function versionGte(a: string, b: string): boolean {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	return true;
}

export type Release = {
	tag_name: string;
	draft: boolean;
	assets: { name: string; browser_download_url: string }[];
};

export type PickedAsset = { name: string; url: string; version: string };

const UA = { "User-Agent": "dg-ai-extension" };

/**
 * A release asset name for a platform+arch, or undefined if that combination
 * isn't built. Kept in lockstep with each release workflow's matrix and
 * bootstrap.sh/bootstrap.ps1's os/arch mapping.
 */
export function cliAssetName(
	binaryName: string,
	platform: string,
	arch: string,
): string | undefined {
	const os = { linux: "linux", darwin: "macos", win32: "windows" }[platform];
	const cpu = { x64: "x64", arm64: "arm64" }[arch];
	if (!os || !cpu) return undefined;
	return `${binaryName}-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
}

/**
 * Newest ext-v* release's -TARGET.zip. /releases is newest-first; we filter to
 * ext-v* because the repo also publishes skills-v* (CLI binaries) — a plain
 * /releases/latest would resolve across all tags and miss the zips.
 */
export function pickExtAsset(
	releases: Release[],
	target: Target,
): PickedAsset | undefined {
	const rel = releases.find((r) => r.tag_name.startsWith("ext-v") && !r.draft);
	const asset = rel?.assets.find((a) => a.name.endsWith(`-${target}.zip`));
	if (!rel || !asset) return undefined;
	return {
		name: asset.name,
		url: asset.browser_download_url,
		version: rel.tag_name.replace(/^ext-v/, ""),
	};
}

export type BinarySpec = { binaryName: string; tagPrefix: string };

export function pickCliAsset(
	releases: Release[],
	spec: BinarySpec,
	platform: string,
	arch: string,
): PickedAsset | undefined {
	const name = cliAssetName(spec.binaryName, platform, arch);
	if (!name) return undefined;
	const rel = releases.find(
		(r) => r.tag_name.startsWith(spec.tagPrefix) && !r.draft,
	);
	const asset = rel?.assets.find((a) => a.name === name);
	if (!rel || !asset) return undefined;
	return {
		name: asset.name,
		url: asset.browser_download_url,
		version: rel.tag_name.slice(spec.tagPrefix.length),
	};
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

export type MissingCliAssetReason =
	| { kind: "no-platform-asset" }
	| { kind: "no-matching-release"; releasesScanned: number };

export function describeMissingCliAsset(
	spec: BinarySpec,
	releases: Release[],
): MissingCliAssetReason {
	const hasRelease = releases.some(
		(r) => r.tag_name.startsWith(spec.tagPrefix) && !r.draft,
	);
	return hasRelease
		? { kind: "no-platform-asset" }
		: { kind: "no-matching-release", releasesScanned: releases.length };
}

/** Download the newest extension release's zip for `target` to a temp file. */
export async function downloadReleaseAsset(
	target: Target,
): Promise<{ zip: string; version: string }> {
	const asset = pickExtAsset(await listReleases(), target);
	if (!asset) throw new Error(`no ext-v* ${target} asset found`);
	const dl = await fetch(asset.url, { headers: UA });
	if (!dl.ok) throw new Error(`asset download failed: HTTP ${dl.status}`);
	const zip = join(tmpdir(), asset.name);
	writeFileSync(zip, Buffer.from(await dl.arrayBuffer()));
	return { zip, version: asset.version };
}

export function cliDest(binaryName: string): string {
	const name = process.platform === "win32" ? `${binaryName}.exe` : binaryName;
	return join(homedir(), ".dg", "bin", name);
}

export function cliVersionFile(binaryName: string): string {
	return join(homedir(), ".dg", "bin", `.${binaryName}.version`);
}

export function resolveCliAsset(
	spec: BinarySpec,
	releases: Release[],
): PickedAsset | undefined {
	return pickCliAsset(releases, spec, process.platform, process.arch);
}

export async function fetchCliBinary(
	binaryName: string,
	asset: PickedAsset,
): Promise<string> {
	const dl = await fetch(asset.url, { headers: UA });
	if (!dl.ok)
		throw new Error(`${binaryName} download failed: HTTP ${dl.status}`);
	const buf = Buffer.from(await dl.arrayBuffer());
	const binDir = join(homedir(), ".dg", "bin");
	mkdirSync(binDir, { recursive: true });
	const dest = cliDest(binaryName);
	const staging = join(binDir, `.${binaryName}.${process.pid}.tmp`);
	try {
		writeFileSync(staging, buf);
		chmodSync(staging, 0o755);
		renameSync(staging, dest);
	} catch (err) {
		rmSync(staging, { force: true });
		throw err;
	}
	writeFileSync(cliVersionFile(binaryName), `${asset.version}\n`);
	return dest;
}
