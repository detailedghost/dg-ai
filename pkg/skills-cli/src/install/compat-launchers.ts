import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DgPaths } from "@dg/common/node/dg-paths";
import { PROGRAM_NAMES } from "@dg/common/node/program";

const RELEASE_IN_TEXT = /this path is removed in (\d+\.\d+\.\d+)/;

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

/** True when the legacy bin file is the notice launcher text that an older install wrote. */
export function isCompatLauncher(paths: DgPaths, file: string, platform: NodeJS.Platform): boolean {
	try {
		const text = readFileSync(join(paths.legacyHome, "bin", file), "utf8");
		const release = RELEASE_IN_TEXT.exec(text)?.[1];
		const name = platform === "win32" ? file.replace(/\.cmd$/, "") : file;
		return release !== undefined && text === compatLauncherText(name, join(paths.binDir, file), release, platform);
	} catch {
		return false;
	}
}

function removeIfEmpty(dir: string): void {
	if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Removes the `<legacyHome>/bin/*` notice launchers that older installs wrote; their targets are gone. */
export function removeCompatLaunchers(paths: DgPaths, platform: NodeJS.Platform = process.platform): void {
	const legacyBin = join(paths.legacyHome, "bin");
	if (legacyBin === paths.binDir || !existsSync(legacyBin)) return;
	for (const name of PROGRAM_NAMES) {
		const file = platform === "win32" ? `${name}.cmd` : name;
		if (isCompatLauncher(paths, file, platform)) rmSync(join(legacyBin, file), { force: true });
	}
	const launchersLeft = PROGRAM_NAMES.some((name) => existsSync(join(legacyBin, platform === "win32" ? `${name}.cmd` : name)));
	if (!launchersLeft) {
		for (const name of PROGRAM_NAMES) rmSync(join(legacyBin, `${name}.version`), { force: true });
	}
	removeIfEmpty(legacyBin);
	removeIfEmpty(paths.legacyHome);
}
