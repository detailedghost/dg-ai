import {
	chmodSync,
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DgPaths } from "@dg/common/node/dg-paths";
import { versionGte } from "../utils/lib";
import { PROGRAMS } from "./shims";

const RELEASE_IN_TEXT = /this path is removed in (\d+\.\d+\.\d+)/;

export function removalRelease(version: string): string {
	const [major, minor] = version.split(".").map(Number);
	return `${major}.${(minor ?? 0) + 2}.0`;
}

const shQuote = (value: string): string =>
	`'${value.replaceAll("'", "'\\''")}'`;

export function compatLauncherText(
	name: string,
	target: string,
	release: string,
	platform: NodeJS.Platform,
): string {
	const notice = `dg: ~/.dg/bin/${name} is now ${target}; this path is removed in ${release}`;
	if (platform === "win32") {
		const percent = (text: string) => text.replaceAll("%", "%%");
		const echoed = percent(notice).replace(/[\^&|<>()]/g, "^$&");
		return ["@echo off", `echo ${echoed} 1>&2`, `"${percent(target)}" %*`, ""].join("\r\n");
	}
	return [
		"#!/bin/sh",
		`printf '%s\\n' ${shQuote(notice)} >&2`,
		`exec ${shQuote(target)} "$@"`,
		"",
	].join("\n");
}

/** True when the legacy bin file is the launcher text written by `syncCompatLaunchers` and its replacement exists in the launcher folder. */
export function isCompatLauncher(paths: DgPaths, file: string, platform: NodeJS.Platform): boolean {
	const replacement = join(paths.binDir, file);
	if (!existsSync(replacement)) return false;
	try {
		const text = readFileSync(join(paths.legacyHome, "bin", file), "utf8");
		const release = RELEASE_IN_TEXT.exec(text)?.[1];
		const name = platform === "win32" ? file.replace(/\.cmd$/, "") : file;
		return release !== undefined && text === compatLauncherText(name, replacement, release, platform);
	} catch {
		return false;
	}
}

function writeAtomic(path: string, text: string): void {
	const staged = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(staged, text);
		chmodSync(staged, 0o755);
		renameSync(staged, path);
	} catch (err) {
		rmSync(staged, { force: true });
		throw err;
	}
}

function removeIfEmpty(dir: string): void {
	if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Keeps `<legacyHome>/bin/*` as notice-printing launchers for two minor releases after the move,
 * then removes them. A fresh machine, or a DG_HOME whose bin folder did not move, gets nothing.
 */
export function syncCompatLaunchers(
	paths: DgPaths,
	version: string,
	platform: NodeJS.Platform = process.platform,
): void {
	const legacyBin = join(paths.legacyHome, "bin");
	if (legacyBin === paths.binDir || !existsSync(legacyBin)) return;
	const windows = platform === "win32";
	for (const name of PROGRAMS) {
		const file = windows ? `${name}.cmd` : name;
		const path = join(legacyBin, file);
		const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
		const release =
			RELEASE_IN_TEXT.exec(existing)?.[1] ?? removalRelease(version);
		if (versionGte(version, release)) {
			rmSync(path, { force: true });
			continue;
		}
		const text = compatLauncherText(
			name,
			join(paths.binDir, file),
			release,
			platform,
		);
		if (existing !== text) writeAtomic(path, text);
	}
	removeIfEmpty(legacyBin);
	removeIfEmpty(paths.legacyHome);
}
