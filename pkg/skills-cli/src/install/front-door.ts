import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "@dg/common";
import { setting } from "@dg/common/node/dg-toml";
import { expectedSha256, type PickedProgram, type ProgramEncoding, UA } from "../utils/lib";
import { programExeName } from "./current";

export type InstallLayout = { dg: string; dgCore: string };

export class FrontDoorUnavailable extends Error {
	override name = "FrontDoorUnavailable";
}

export const coreExeName = (platform: NodeJS.Platform): string => (platform === "win32" ? "dg-core.exe" : "dg-core");

/** The NativeAOT RID that serves a Bun platform key; the baseline builds share the x64 front door. */
export const frontDoorRid = (key: string): string =>
	key.replace(/-baseline$/, "").replace(/^darwin-/, "osx-").replace(/^windows-/, "win-");

/** The front door release asset for a Bun platform key: `dg-front-<rid>`, with `.exe` on Windows. */
export const frontDoorAssetName = (key: string): string => `dg-front-${frontDoorRid(key)}${key.startsWith("windows-") ? ".exe" : ""}`;

/** Where one version keeps its files: `dg` is what runs, `dgCore` is the Bun program (the same file as `dg` with the front door off). */
export function installLayout({
	root,
	version,
	platform = process.platform,
	front = true,
}: {
	root: string;
	version: string;
	platform?: NodeJS.Platform;
	front?: boolean;
}): InstallLayout {
	const dir = join(root, "bin", version);
	const dg = join(dir, programExeName(platform));
	return { dg, dgCore: front ? join(dir, coreExeName(platform)) : dg };
}

/** True when the installed version keeps the Bun program beside a front door. */
export const hasFrontDoor = (root: string, version: string, platform: NodeJS.Platform): boolean =>
	existsSync(installLayout({ root, version, platform }).dgCore);

export const frontDoorSkipped = (reason: string): string =>
	`dg: the front door was not installed (${reason.split("\n")[0]}); dg runs the Bun program only`;

/** DG_FRONT, then front.enabled in config.toml, then on; a config that cannot be read keeps the Bun-only layout. */
export function frontEnabled(
	env: NodeJS.ProcessEnv = process.env,
	warn: (line: string) => void = (line) => void process.stderr.write(`${line}\n`),
): boolean {
	try {
		return setting<boolean>("front.enabled", { envVar: "DG_FRONT", env });
	} catch (error) {
		warn(frontDoorSkipped(describeError(error)));
		return false;
	}
}

const PROGRAM_ASSET = /^dg-(.+?)(?:\.exe)?(?:\.zst|\.gz)?$/;

/** The front door asset of the release that `release` names, read from its SHA256SUMS; throws FrontDoorUnavailable when the release has none. */
export async function pickFrontDoor(release: PickedProgram): Promise<PickedProgram> {
	const key = PROGRAM_ASSET.exec(release.assetName)?.[1];
	if (!key) throw new FrontDoorUnavailable(`${release.assetName} is not a dg program asset`);
	const raw = frontDoorAssetName(key);
	const res = await fetch(release.sumsUrl, { headers: UA });
	if (!res.ok) throw new FrontDoorUnavailable(`SHA256SUMS answered HTTP ${res.status}`);
	const sums = await res.text();
	if (!expectedSha256(sums, raw)) throw new FrontDoorUnavailable(`v${release.version} has no ${raw}`);
	const pick = (assetName: string, encoding: ProgramEncoding): PickedProgram => ({
		version: release.version,
		assetName,
		url: new URL(assetName, release.url).href,
		sumsUrl: release.sumsUrl,
		encoding,
	});
	if (release.encoding !== "raw") {
		if (expectedSha256(sums, `${raw}.zst`)) return pick(`${raw}.zst`, "zstd");
		if (expectedSha256(sums, `${raw}.gz`)) return pick(`${raw}.gz`, "gzip");
	}
	return pick(raw, "raw");
}
