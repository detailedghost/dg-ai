/**
 * Shared helpers for the browser-batch CLI (install/launch/detect):
 * platform detection, subprocess running, per-OS extension paths, zip
 * extraction, and fetching the CI-built extension from GitHub Releases.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type Target = "chrome" | "firefox";
export const REPO = "detailedghost/dg-ai";

export function isWSL(): boolean {
	if (process.env.WSL_DISTRO_NAME) return true;
	if (process.platform !== "linux") return false;
	try {
		return readFileSync("/proc/version", "utf8")
			.toLowerCase()
			.includes("microsoft");
	} catch {
		return false;
	}
}

export function run(command: string, args: string[]): string {
	const r = spawnSync(command, args, { encoding: "utf8" });
	if (r.error) {
		throw new Error(
			`${command} not found or failed to start: ${r.error.message}`,
		);
	}
	if (r.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
		);
	}
	return r.stdout.trim();
}

/** Repo root: the plugin dir when installed, else three levels up from bin/. */
export function repoRoot(): string {
	return process.env.CLAUDE_PLUGIN_ROOT ?? resolve(import.meta.dir, "../../..");
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

type Release = {
	tag_name: string;
	assets: { name: string; browser_download_url: string }[];
};

/** Download the newest release's asset for `target` to a temp .zip. */
export async function downloadReleaseAsset(
	target: Target,
): Promise<{ zip: string; version: string }> {
	const headers = { "User-Agent": "dg-ai-extension" };
	const res = await fetch(
		`https://api.github.com/repos/${REPO}/releases/latest`,
		{ headers },
	);
	if (!res.ok)
		throw new Error(`GitHub API ${res.status} fetching latest release`);
	const rel = (await res.json()) as Release;
	const asset = rel.assets.find((a) => a.name.endsWith(`-${target}.zip`));
	if (!asset) throw new Error(`no ${target} asset in release ${rel.tag_name}`);
	const dl = await fetch(asset.browser_download_url, { headers });
	if (!dl.ok) throw new Error(`asset download failed: HTTP ${dl.status}`);
	const zip = join(tmpdir(), asset.name);
	writeFileSync(zip, Buffer.from(await dl.arrayBuffer()));
	return { zip, version: rel.tag_name.replace(/^v/, "") };
}
