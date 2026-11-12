import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractZip, sha256Hex, UA, type PickedBundle, verifyReleaseAsset } from "../utils/lib";
import { linkCurrent, readCurrent } from "./current";

export type RuntimePin = {
	version: string;
	assets: Record<string, { file: string; sha256: string }>;
};

const BUN = process.platform === "win32" ? "bun.exe" : "bun";
const BUN_DOWNLOADS = "https://github.com/oven-sh/bun/releases/download";

function hasAvx2(cpuinfoFile: string): boolean {
	try {
		return /^flags\s*:.*\bavx2\b/m.test(readFileSync(cpuinfoFile, "utf8"));
	} catch {
		return true;
	}
}

/** The runtime.json asset key for this host; linux-x64 without avx2 takes the baseline build. */
export function runtimeAssetKey(
	platform: string = process.platform,
	arch: string = process.arch,
	cpuinfoFile: string = process.env.DG_CPUINFO_FILE || "/proc/cpuinfo",
): string {
	const base = `${platform === "win32" ? "windows" : platform}-${arch}`;
	return base === "linux-x64" && !hasAvx2(cpuinfoFile) ? `${base}-baseline` : base;
}

/** Fetches runtime.json from the release and trusts it only after SHA256SUMS lists its hash. */
export async function fetchRuntimePin(release: PickedBundle): Promise<RuntimePin> {
	const res = await fetch(new URL("runtime.json", release.url), { headers: UA });
	if (!res.ok) throw new Error(`runtime.json download failed: HTTP ${res.status}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	await verifyReleaseAsset(release.sumsUrl, "runtime.json", buf, `v${release.version}`);
	const pin = JSON.parse(new TextDecoder().decode(buf)) as RuntimePin;
	if (typeof pin.version !== "string" || typeof pin.assets !== "object" || pin.assets === null) {
		throw new Error(`runtime.json in v${release.version} is malformed`);
	}
	return pin;
}

/**
 * Installs the pinned Bun under `<root>/runtime/bun-v<version>/` without switching `runtime/current`.
 * Returns the realpath of the bun binary. Nothing changes when the zip fails its sha256 check.
 */
export async function stageRuntime(root: string, pin: RuntimePin): Promise<string> {
	const runtimeDir = join(root, "runtime");
	const dirName = `bun-v${pin.version}`;
	const finalDir = join(runtimeDir, dirName);
	const bin = join(finalDir, BUN);
	if (!existsSync(bin)) {
		const key = runtimeAssetKey();
		const asset = pin.assets[key];
		if (!asset) throw new Error(`runtime.json has no Bun build for ${key}`);
		const res = await fetch(`${BUN_DOWNLOADS}/${dirName}/${asset.file}`, { headers: UA });
		if (!res.ok) throw new Error(`${asset.file} download failed: HTTP ${res.status}`);
		const zip = new Uint8Array(await res.arrayBuffer());
		if (sha256Hex(zip) !== asset.sha256.toLowerCase()) throw new Error(`checksum mismatch for ${asset.file}`);
		mkdirSync(runtimeDir, { recursive: true });
		const staging = mkdtempSync(join(runtimeDir, `install-${dirName}-`));
		try {
			const zipPath = join(staging, "bun.zip");
			writeFileSync(zipPath, zip);
			extractZip(zipPath, join(staging, "x"));
			const stagedDir = join(staging, "bun");
			mkdirSync(stagedDir);
			const stagedBin = join(stagedDir, BUN);
			renameSync(join(staging, "x", asset.file.replace(/\.zip$/, ""), BUN), stagedBin);
			chmodSync(stagedBin, 0o755);
			try {
				renameSync(stagedDir, finalDir);
			} catch (err) {
				if (!existsSync(bin)) throw err;
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	}
	return realpathSync(bin);
}

/** Points `runtime/current` at the pinned Bun that `stageRuntime` installed; the result puts the old link back. */
export function activateRuntime(root: string, pin: RuntimePin): () => void {
	const dirName = `bun-v${pin.version}`;
	const previous = readCurrent(root, "runtime");
	if (previous !== dirName) linkCurrent(root, "runtime", dirName);
	return () => {
		if (previous) linkCurrent(root, "runtime", previous);
		else rmSync(join(root, "runtime", "current"), { force: true });
	};
}
