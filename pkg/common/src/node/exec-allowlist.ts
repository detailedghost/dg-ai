import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";

/** The flag that lets a listed shell, interpreter or general tool take any arguments. */
export const EXEC_ALLOW_ANY_ARGS = "allow-any-args";

/** The hex sha256 of a file's bytes, or undefined when it cannot be read. */
export function fileSha256(path: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return undefined;
	}
}

/** A ready exec-allowlist line for a file: its real path, its sha256 pin, an optional glob and flag. */
export function execAllowlistLine(path: string, glob?: string, anyArgs = false): string {
	const real = realpathSync(path);
	const hash = fileSha256(real);
	if (!hash) throw new Error(`Cannot read ${real}.`);
	return [quoteAllowlistPath(real), `sha256=${hash}`, ...(glob ? [glob] : []), ...(anyArgs ? [EXEC_ALLOW_ANY_ARGS] : [])].join(" ");
}

/** Quotes a path for the allowlist when it holds whitespace, a quote, a backslash or a #. */
export function quoteAllowlistPath(path: string): string {
	return /[\s"\\#]/.test(path) ? `"${path.replace(/[\\"]/g, "\\$&")}"` : path;
}
