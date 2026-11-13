import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

/** One allowlist line: an absolute executable, an optional pw/ name glob, and the interpreter opt-in. */
export type ExecAllowEntry = { path: string; glob?: string; allowInterpreter: boolean };

const INTERPRETER =
	/^(?:sh|bash|zsh|fish|dash|ksh|mksh|csh|tcsh|ash|busybox|env|python[\d.]*|pypy[\d.]*|node(?:js)?|bun|bunx|deno|npx|perl[\d.]*|ruby[\d.]*|php[\d.]*|lua[\d.]*|tclsh[\d.]*|osascript|pwsh|powershell|cmd|xargs|parallel|nohup|timeout|nice|ionice|setsid|stdbuf|sudo|doas|su|runuser|chroot|unshare|script|watch|find|awk|gawk|mawk|nawk|sed|expect|ssh|time)$/i;

/** Parses the allowlist text: one entry per line, # starts a comment. */
export function parseExecAllowlist(text: string): ExecAllowEntry[] {
	return text.split(/\r?\n/).flatMap((line) => {
		const fields = line.replace(/#.*$/, "").trim().split(/\s+/).filter(Boolean);
		const [path, ...rest] = fields;
		if (!path || !isAbsolute(path)) return [];
		const allowInterpreter = rest.includes("allow-interpreter");
		const glob = rest.find((field) => field !== "allow-interpreter");
		return [{ path, ...(glob === undefined ? {} : { glob }), allowInterpreter }];
	});
}

function globMatches(glob: string, name: string): boolean {
	const pattern = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${pattern}$`).test(name);
}

function real(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** True for a shell, interpreter or launcher that can run any code it is given. */
export function isInterpreter(path: string): boolean {
	return INTERPRETER.test(basename(path).replace(/\.exe$/i, ""));
}

/** Resolves argv[0] to a real absolute path: a bare name through the daemon's own PATH, a path from the working directory. */
export function resolveExecutable(command: string, cwd: string, daemonPath = process.env.PATH ?? ""): string | undefined {
	if (command.includes("/") || command.includes("\\")) return real(resolve(cwd, command));
	const found = Bun.which(command, { PATH: daemonPath });
	return found ? real(found) : undefined;
}

/** Checks a command against the allowlist file for the given pw/ names; the result never holds a value. */
export function checkExecAllowlist({
	file,
	command,
	cwd,
	names,
	daemonPath,
}: {
	file: string;
	command: string;
	cwd: string;
	names: readonly string[];
	daemonPath?: string;
}): { ok: true; path: string } | { ok: false; error: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {
			ok: false,
			error: `credentials exec runs commands with pw/ values only when ${file} lists them. The file does not exist. The person adds a line with the absolute path of the command, for example: /usr/bin/curl pw/live.com/*`,
		};
	}
	const resolved = resolveExecutable(command, cwd, daemonPath);
	if (!resolved) return { ok: false, error: `credentials exec could not find ${command} as an executable file.` };
	const entry = parseExecAllowlist(text).find(
		(candidate) => real(candidate.path) === resolved && names.every((name) => !candidate.glob || globMatches(candidate.glob, name)),
	);
	if (!entry)
		return {
			ok: false,
			error: `${resolved} is not listed in ${file} for ${names.join(", ")}. The person adds it there to allow it.`,
		};
	if (isInterpreter(resolved) && !entry.allowInterpreter)
		return {
			ok: false,
			error: `${resolved} is a shell or interpreter, which can run any code, so credentials exec refuses it with pw/ values even though ${file} lists it. Only an entry with allow-interpreter allows it.`,
		};
	return { ok: true, path: resolved };
}
