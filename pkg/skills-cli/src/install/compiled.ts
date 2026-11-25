import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { evictFromPageCache } from "@dg/common/node/page-cache";
import { compiledProgramPath, PROGRAM_NAMES } from "@dg/common/node/program";
import { decodeProgram, expectedSha256, type PickedProgram, rawAssetName, UA, verifyReleaseAsset } from "../utils/lib";
import { linkCurrent, programExeName, readCurrent, VERSION_DIR } from "./current";
import { isDgLauncher } from "./dg-launcher";
import { coreExeName, frontDoorSkipped, frontEnabled, hasFrontDoor, installLayout, pickFrontDoor } from "./front-door";
import { applyPatch, patchAssetName } from "./patch";

/** `<root>/bin/<version>/dg[.exe]`. */
export const versionProgramPath = (root: string, version: string, platform: NodeJS.Platform = process.platform): string =>
	join(root, "bin", version, programExeName(platform));

function selfCheck(program: string, version: string): void {
	const result = spawnSync(program, ["--version"], { encoding: "utf8", timeout: 30_000 });
	if (result.error) throw new Error(`dg self-check could not start: ${result.error.message}`);
	if (result.status !== 0) {
		const detail = result.stderr.trim().split("\n").at(-1) || `exit ${result.status}`;
		throw new Error(`dg self-check failed: ${detail}`);
	}
	const printed = result.stdout.trim();
	if (printed.split(/\s+/)[0] !== version) throw new Error(`dg self-check failed: expected ${version}, printed ${printed || "nothing"}`);
}

function pruneVersions(bin: string, keep: ReadonlySet<string>): void {
	try {
		for (const name of readdirSync(bin)) {
			if (VERSION_DIR.test(name) && !keep.has(name)) rmSync(join(bin, name), { recursive: true, force: true });
		}
	} catch (err) {
		console.warn(`⚠ could not remove old dg versions: ${err instanceof Error ? err.message : err}`);
	}
}

async function downloadPatched(release: PickedProgram, from: string, fromProgram: string): Promise<Uint8Array | undefined> {
	const patchUrl = new URL(patchAssetName(release.assetName, from), release.url).href;
	const res = await fetch(patchUrl, { headers: UA });
	if (!res.ok) return undefined;
	const patch = new Uint8Array(await res.arrayBuffer());
	const sums = await fetch(release.sumsUrl, { headers: UA });
	if (!sums.ok) return undefined;
	const expected = expectedSha256(await sums.text(), rawAssetName(release.assetName));
	if (!expected) return undefined;
	return applyPatch(readFileSync(fromProgram), patch, expected);
}

async function download(release: PickedProgram, staged: string, from?: { version: string; program: string }): Promise<void> {
	let bytes: Uint8Array | undefined;
	if (from && existsSync(from.program) && !Bun.which("zstd")) {
		warnOnStderr("dg: zstd is not on PATH, so the patch is skipped; downloading the full program");
	} else if (from && existsSync(from.program)) {
		try {
			bytes = await downloadPatched(release, from.version, from.program);
		} catch (err) {
			warnOnStderr(`dg: patch from ${from.version} failed (${err instanceof Error ? err.message : err}); downloading the full program`);
		}
	}
	if (!bytes) {
		const res = await fetch(release.url, { headers: UA });
		if (!res.ok) throw new Error(`${release.assetName} download failed: HTTP ${res.status}`);
		const downloaded = new Uint8Array(await res.arrayBuffer());
		bytes = decodeProgram(downloaded, release.encoding, release.assetName);
		await verifyReleaseAsset(release.sumsUrl, rawAssetName(release.assetName), bytes, `v${release.version}`);
	}
	writeFileSync(staged, bytes);
	chmodSync(staged, 0o755);
}

export type InstallOptions = {
	front?: boolean;
	env?: NodeJS.ProcessEnv;
};

type Installed = { version: string; core: string; front?: string };

function installedOf(root: string, version: string, platform: NodeJS.Platform): Installed {
	const front = hasFrontDoor(root, version, platform);
	const layout = installLayout({ root, version, platform, front });
	return { version, core: layout.dgCore, ...(front ? { front: layout.dg } : {}) };
}

function moveOver(source: string, dest: string, platform: NodeJS.Platform): void {
	if (platform !== "win32" || !present(dest)) {
		renameSync(source, dest);
		return;
	}
	const aside = `${dest}.${process.pid}-${Date.now()}.old`;
	renameSync(dest, aside);
	try {
		renameSync(source, dest);
	} catch (err) {
		renameSync(aside, dest);
		throw err;
	}
	rmSync(aside, { force: true });
}

async function addFrontDoor(staging: string, release: PickedProgram, platform: NodeJS.Platform, from?: Installed): Promise<void> {
	const dg = join(staging, programExeName(platform));
	const core = join(staging, coreExeName(platform));
	const candidate = join(staging, ".front-door");
	try {
		const picked = await pickFrontDoor(release);
		await download(picked, candidate, from?.front ? { version: from.version, program: from.front } : undefined);
		renameSync(dg, core);
		try {
			renameSync(candidate, dg);
			selfCheck(dg, release.version);
		} catch (err) {
			renameSync(core, dg);
			throw err;
		}
	} catch (err) {
		rmSync(candidate, { force: true });
		warnOnStderr(frontDoorSkipped(err instanceof Error ? err.message : String(err)));
	}
}

/** Installs the verified compiled dg under `<root>/bin/<version>/` and points `bin/current` at it; the front door goes at `dg` and the Bun program at `dg-core` when it passes its checks. */
export async function installCompiled(
	root: string,
	release: PickedProgram,
	platform: NodeJS.Platform = process.platform,
	options: InstallOptions = {},
): Promise<string> {
	const bin = join(root, "bin");
	const front = options.front ?? frontEnabled(options.env);
	const final = versionProgramPath(root, release.version, platform);
	const installed = readCurrent(root, "bin");
	const from = installed && installed !== release.version ? installedOf(root, installed, platform) : undefined;
	if (!existsSync(final)) {
		mkdirSync(bin, { recursive: true });
		const staging = mkdtempSync(join(bin, `.${release.version}.staging-`));
		try {
			const staged = join(staging, programExeName(platform));
			await download(release, staged, from && { version: from.version, program: from.core });
			selfCheck(staged, release.version);
			evictFromPageCache(staged);
			if (front) await addFrontDoor(staging, release, platform, from);
			if (!existsSync(final)) {
				rmSync(join(bin, release.version), { recursive: true, force: true });
				renameSync(staging, join(bin, release.version));
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	} else if (!front && hasFrontDoor(root, release.version, platform)) {
		const layout = installLayout({ root, version: release.version, platform });
		moveOver(layout.dgCore, layout.dg, platform);
	}
	const replaced = readCurrent(root, "bin");
	linkCurrent(root, "bin", release.version);
	pruneVersions(bin, new Set([release.version, ...(replaced ? [replaced] : [])]));
	return final;
}

const warnOnStderr = (line: string): void => void process.stderr.write(`${line}\n`);

function present(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

function danglingLink(path: string): boolean {
	return present(path) && lstatSync(path).isSymbolicLink() && !existsSync(path);
}

/** True for a file dg wrote: an old launcher, a link into the dg data dir, or a dangling link. */
export function isOwnedLauncher(path: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
	return danglingLink(path) || isDgLauncher(path, platform, root);
}

const ASIDE_PREFIXES = [".dg.exe.", ".dg-core.exe."];

function sweepAside(binDir: string): void {
	let names: string[];
	try {
		names = readdirSync(binDir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!ASIDE_PREFIXES.some((prefix) => name.startsWith(prefix)) || !name.endsWith(".old")) continue;
		try {
			rmSync(join(binDir, name), { force: true });
		} catch {}
	}
}

function hardLinkOver(dest: string, source: string): void {
	const aside = join(dirname(dest), `.${basename(dest)}.${process.pid}-${Date.now()}.old`);
	const moved = present(dest);
	if (moved) renameSync(dest, aside);
	try {
		linkSync(source, dest);
	} catch (err) {
		if (moved) {
			try {
				renameSync(aside, dest);
			} catch {
				throw new Error(`could not link ${dest}; the old ${basename(dest)} is at ${aside}, rename it back`, { cause: err });
			}
		}
		throw err;
	}
}

function hardLinksIntoCore(path: string, root: string): boolean {
	try {
		const { ino, dev } = statSync(path, { bigint: true });
		const bin = join(root, "bin");
		return readdirSync(bin).some((name) => {
			const installed = join(bin, name, coreExeName("win32"));
			if (!VERSION_DIR.test(name) || !existsSync(installed)) return false;
			const other = statSync(installed, { bigint: true });
			return other.ino === ino && other.dev === dev;
		});
	} catch {
		return false;
	}
}

function linkCoreWindows(binDir: string, root: string, version: string, warn: (line: string) => void): void {
	const dest = join(binDir, coreExeName("win32"));
	const source = installLayout({ root, version, platform: "win32" }).dgCore;
	const wanted = existsSync(source);
	if (present(dest) && !hardLinksIntoCore(dest, root)) {
		if (wanted) warn(`dg: kept ${dest}; it is not a dg launcher. Remove it or rename it, then run dg install again`);
		return;
	}
	if (wanted) {
		hardLinkOver(dest, source);
		return;
	}
	try {
		rmSync(dest, { force: true });
	} catch {
		renameSync(dest, join(binDir, `.${coreExeName("win32")}.${process.pid}-${Date.now()}.old`));
	}
}

/** Points `<binDir>/dg` at the compiled program, keeping a `dg` that dg did not write; on Windows a front door gets a `dg-core.exe` link beside it. */
export function writeDgLink(
	binDir: string,
	root: string,
	version: string,
	platform: NodeJS.Platform = process.platform,
	warn: (line: string) => void = warnOnStderr,
): void {
	mkdirSync(binDir, { recursive: true });
	const dest = join(binDir, programExeName(platform));
	if (present(dest) && !isOwnedLauncher(dest, root, platform)) {
		warn(`dg: kept ${dest}; it is not a dg launcher. Remove it or rename it, then run dg install again`);
		return;
	}
	if (platform === "win32") {
		sweepAside(binDir);
		hardLinkOver(dest, versionProgramPath(root, version, platform));
		linkCoreWindows(binDir, root, version, warn);
		return;
	}
	const staged = join(binDir, `.dg.${process.pid}.tmp`);
	rmSync(staged, { force: true });
	symlinkSync(compiledProgramPath(root, platform), staged);
	renameSync(staged, dest);
}

/** Removes the old program launchers that dg wrote; `keepCmd` leaves `.cmd` files in place. */
export function removeOldLaunchers(
	binDir: string,
	root: string,
	platform: NodeJS.Platform = process.platform,
	opts: { keepCmd?: boolean; warn?: (line: string) => void } = {},
): string[] {
	const warn = opts.warn ?? warnOnStderr;
	const files = PROGRAM_NAMES.flatMap((name) => [name, `${name}.cmd`, `${name}.exe`]);
	if (platform === "win32") files.push("dg.cmd");
	const removed: string[] = [];
	for (const file of files) {
		const path = join(binDir, file);
		if (!present(path)) continue;
		if (opts.keepCmd && file.endsWith(".cmd")) continue;
		if (!isOwnedLauncher(path, root, platform)) {
			warn(`dg: kept ${path}; it is not a dg launcher. dg no longer uses that name`);
			continue;
		}
		rmSync(path, { force: true });
		removed.push(path);
	}
	for (const name of PROGRAM_NAMES) rmSync(join(binDir, `.${name}.version`), { force: true });
	return removed;
}
