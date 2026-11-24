import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { evictFromPageCache } from "@dg/common/node/page-cache";
import { compiledProgramPath, PROGRAM_NAMES } from "@dg/common/node/program";
import { type PickedProgram, UA, verifyReleaseAsset } from "../utils/lib";
import { linkCurrent, programExeName, readCurrent, VERSION_DIR } from "./current";
import { isDgLauncher } from "./dg-launcher";

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

async function download(release: PickedProgram, staged: string): Promise<void> {
	const res = await fetch(release.url, { headers: UA });
	if (!res.ok) throw new Error(`${release.assetName} download failed: HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	await verifyReleaseAsset(release.sumsUrl, release.assetName, bytes, `v${release.version}`);
	writeFileSync(staged, bytes);
	chmodSync(staged, 0o755);
}

/** Installs the verified compiled dg under `<root>/bin/<version>/` and points `bin/current` at it. */
export async function installCompiled(
	root: string,
	release: PickedProgram,
	platform: NodeJS.Platform = process.platform,
): Promise<string> {
	const bin = join(root, "bin");
	const final = versionProgramPath(root, release.version, platform);
	if (!existsSync(final)) {
		mkdirSync(bin, { recursive: true });
		const staging = mkdtempSync(join(bin, `.${release.version}.staging-`));
		try {
			const staged = join(staging, programExeName(platform));
			await download(release, staged);
			selfCheck(staged, release.version);
			evictFromPageCache(staged);
			if (!existsSync(final)) {
				rmSync(join(bin, release.version), { recursive: true, force: true });
				renameSync(staging, join(bin, release.version));
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
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

function sweepAside(binDir: string): void {
	let names: string[];
	try {
		names = readdirSync(binDir);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(".dg.exe.") || !name.endsWith(".old")) continue;
		try {
			rmSync(join(binDir, name), { force: true });
		} catch {}
	}
}

/** Points `<binDir>/dg` at the compiled program, keeping a `dg` that dg did not write. */
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
		const aside = join(binDir, `.dg.exe.${process.pid}-${Date.now()}.old`);
		const moved = present(dest);
		if (moved) renameSync(dest, aside);
		try {
			linkSync(versionProgramPath(root, version, platform), dest);
		} catch (err) {
			if (moved) {
				try {
					renameSync(aside, dest);
				} catch {
					throw new Error(`could not link ${dest}; the old dg.exe is at ${aside}, rename it back`, { cause: err });
				}
			}
			throw err;
		}
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
