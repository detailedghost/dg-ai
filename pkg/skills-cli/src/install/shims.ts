import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROGRAM_NAMES } from "@dg/common/node/program";
import cmdTemplate from "../../../launcher/shims/dg.cmd" with { type: "text" };
import shTemplate from "../../../launcher/shims/dg.sh" with { type: "text" };
import { holdsOtherFile } from "./dg-launcher";

export { isDgLauncher } from "./dg-launcher";

export const LEGACY_PROGRAMS = PROGRAM_NAMES;
export const PROGRAMS = ["dg", ...LEGACY_PROGRAMS] as const;

const warnOnStderr = (line: string): void => void process.stderr.write(`${line}\n`);

const quotePosix = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const escapeCmd = (value: string): string => value.replaceAll("%", "%%");

function render(template: string, root: string, name: string, windows: boolean): string {
	const rootText = windows ? escapeCmd(root) : quotePosix(root);
	return template.replaceAll("{{ROOT}}", () => rootText).replaceAll("{{NAME}}", () => name);
}

/**
 * Writes the four launchers in `bin`, each running the runtime and bundle under `root`. Each is staged
 * beside its destination and renamed over it, so a compiled binary of the same name is replaced only once
 * the shim exists. A `dg` file that is not a dg launcher stays, with one warning.
 */
export function writeShims(
	bin: string,
	root: string,
	platform: NodeJS.Platform = process.platform,
	warn: (line: string) => void = warnOnStderr,
): void {
	const windows = platform === "win32";
	mkdirSync(bin, { recursive: true });
	for (const name of PROGRAMS) {
		const dest = join(bin, windows ? `${name}.cmd` : name);
		if (name === "dg" && holdsOtherFile(dest, platform)) {
			warn(`dg: kept ${dest}; it is not a dg launcher. Remove it or rename it, then run dg-skills install again`);
			continue;
		}
		const staged = join(bin, `.${name}.${process.pid}.tmp`);
		try {
			writeFileSync(staged, render(windows ? cmdTemplate : shTemplate, root, name, windows));
			chmodSync(staged, 0o755);
			renameSync(staged, dest);
		} catch (err) {
			rmSync(staged, { force: true });
			throw err;
		}
		if (windows && name !== "dg") rmSync(join(bin, `${name}.exe`), { force: true });
	}
}
