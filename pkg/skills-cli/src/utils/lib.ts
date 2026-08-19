/**
 * Shared helpers for the dg-browser CLI (batch-open/demo/install/launch/detect):
 * per-OS extension paths, zip extraction, and fetching the CI-built extension
 * from GitHub Releases. Platform detection (isWSL) and subprocess running
 * (run) live in @dg/common/node and are only imported here.
 */

import {
	chmodSync,
	mkdirSync,
	readFileSync,
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
 * The skills-v* release asset name for a platform+arch, or undefined if the
 * combination isn't built. Kept in lockstep with skills-release.yml's matrix
 * and bootstrap.sh/bootstrap.ps1's os/arch mapping.
 */
export function cliAssetName(
	platform: string,
	arch: string,
): string | undefined {
	const os = { linux: "linux", darwin: "macos", win32: "windows" }[platform];
	const cpu = { x64: "x64", arm64: "arm64" }[arch];
	if (!os || !cpu) return undefined;
	return `dg-skills-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
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

/** Newest skills-v* release's binary for platform+arch. */
export function pickCliAsset(
	releases: Release[],
	platform: string,
	arch: string,
): PickedAsset | undefined {
	const name = cliAssetName(platform, arch);
	if (!name) return undefined;
	const rel = releases.find(
		(r) => r.tag_name.startsWith("skills-v") && !r.draft,
	);
	const asset = rel?.assets.find((a) => a.name === name);
	if (!rel || !asset) return undefined;
	return {
		name: asset.name,
		url: asset.browser_download_url,
		version: rel.tag_name.replace(/^skills-v/, ""),
	};
}

async function listReleases(): Promise<Release[]> {
	const res = await fetch(
		`https://api.github.com/repos/${REPO}/releases?per_page=30`,
		{ headers: UA },
	);
	if (!res.ok) throw new Error(`GitHub API ${res.status} listing releases`);
	return (await res.json()) as Release[];
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

/** Stable path for the compiled CLI binary (runs in the shell, so always local home). */
export function cliDest(): string {
	const name = process.platform === "win32" ? "dg-skills.exe" : "dg-skills";
	return join(homedir(), ".dg", "bin", name);
}

/** Records the installed CLI version so `install` can skip a needless ~big re-download. */
export function cliVersionFile(): string {
	return join(homedir(), ".dg", "bin", ".dg-skills.version");
}

/** The newest skills-v* binary for this platform, or undefined if unbuilt/unavailable. */
export function resolveCliAsset(): Promise<PickedAsset | undefined> {
	return listReleases().then((r) =>
		pickCliAsset(r, process.platform, process.arch),
	);
}

/** Download a resolved CLI asset to cliDest() and stamp its version. */
export async function fetchCliBinary(asset: PickedAsset): Promise<string> {
	const dl = await fetch(asset.url, { headers: UA });
	if (!dl.ok) throw new Error(`CLI binary download failed: HTTP ${dl.status}`);
	const dest = cliDest();
	mkdirSync(join(homedir(), ".dg", "bin"), { recursive: true });
	writeFileSync(dest, Buffer.from(await dl.arrayBuffer()));
	chmodSync(dest, 0o755);
	writeFileSync(cliVersionFile(), `${asset.version}\n`);
	return dest;
}
