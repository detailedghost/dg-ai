import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Override source/compiled invocation detection, mainly for embedding and isolated tests. */
export interface SelfCommandOptions {
	execPath?: string;
	entrypoint?: string;
	compiled?: boolean;
}

/** Build argv for this compiled binary or a real source entrypoint; reject virtual Bun executable paths. */
export function selfCommand(
	args: string[],
	opts: SelfCommandOptions = {},
): string[] {
	const execPath = opts.execPath ?? process.execPath;
	const entrypoint = opts.entrypoint ?? (Bun.main || process.argv[1]);
	const virtual = (value: string | undefined) =>
		/(?:^|\/)(?:\$bunfs|~BUN)(?:\/|$)/i.test(
			value?.replaceAll("\\", "/") ?? "",
		);
	if (virtual(execPath))
		throw new Error("Cannot execute a virtual Bun filesystem path");
	if (opts.compiled ?? virtual(entrypoint)) return [execPath, ...args];
	if (!entrypoint || virtual(entrypoint))
		throw new Error("A real source entrypoint is required for self invocation");
	const source = isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint);
	if (!existsSync(source))
		throw new Error(`Source entrypoint does not exist: ${source}`);
	return [execPath, source, ...args];
}

/** Quote every argv element for a POSIX shell, including empty strings and embedded single quotes. */
export function shellCommand(argv: readonly string[]): string {
	return argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}
