import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import cmdTemplate from "../../../launcher/shims/dg.cmd" with { type: "text" };
import shTemplate from "../../../launcher/shims/dg.sh" with { type: "text" };

export const PROGRAMS = ["dg-skills", "dg-agent", "dg-daemon"] as const;

const quotePosix = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const escapeCmd = (value: string): string => value.replaceAll("%", "%%");

function render(template: string, root: string, name: string, windows: boolean): string {
	const rootText = windows ? escapeCmd(root) : quotePosix(root);
	return template.replaceAll("{{ROOT}}", () => rootText).replaceAll("{{NAME}}", () => name);
}

/**
 * Writes the three launchers in `bin`, each running the runtime and bundle under `root`. Each is staged
 * beside its destination and renamed over it, so a compiled binary of the same name is replaced only once
 * the shim exists.
 */
export function writeShims(bin: string, root: string, platform: NodeJS.Platform = process.platform): void {
	const windows = platform === "win32";
	mkdirSync(bin, { recursive: true });
	for (const name of PROGRAMS) {
		const dest = join(bin, windows ? `${name}.cmd` : name);
		const staged = join(bin, `.${name}.${process.pid}.tmp`);
		try {
			writeFileSync(staged, render(windows ? cmdTemplate : shTemplate, root, name, windows));
			chmodSync(staged, 0o755);
			renameSync(staged, dest);
		} catch (err) {
			rmSync(staged, { force: true });
			throw err;
		}
		if (windows) rmSync(join(bin, `${name}.exe`), { force: true });
	}
}
