import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { EXEC_ALLOW_ANY_ARGS as ALLOW_ANY_ARGS } from "@dg/common/node";
import { basename, isAbsolute, resolve } from "node:path";

/** One allowlist line: an absolute executable, its sha256 pin, an optional pw/ name glob, and the any-args opt-in. */
export type ExecAllowEntry = { path: string; sha256?: string; glob?: string; allowAnyArgs: boolean };

const GENERAL_TOOL =
	/^(?:sh|bash|zsh|fish|dash|ksh|mksh|csh|tcsh|ash|busybox|toybox|env|python[\d.]*|pypy[\d.]*|node(?:js)?|bun|bunx|deno|npx|npm|pnpm|yarn|perl[\d.]*|ruby[\d.]*|php[\d.]*|lua[\d.]*|tclsh[\d.]*|osascript|pwsh|powershell|cmd|xargs|parallel|nohup|timeout|nice|ionice|setsid|stdbuf|sudo|doas|su|runuser|chroot|unshare|script|watch|find|awk|gawk|mawk|nawk|sed|expect|ssh|scp|sftp|rsync|time|curl|wget|httpie|http|https|nc|ncat|netcat|socat|telnet|ftp|git|hg|svn|tar|zip|unzip|make|cmake|docker|podman|kubectl|vi|vim|nvim|emacs|nano|less|more|man|tee|dd|cp|mv|install|openssl|gpg|jq|aws|gcloud|az|gh|glab)$/i;

/** Parses the allowlist text: one entry per line, # starts a comment. */
export function parseExecAllowlist(text: string): ExecAllowEntry[] {
	return text.split(/\r?\n/).flatMap((line) => {
		const split = splitAllowlistLine(line);
		if (!split) return [];
		const { path, rest } = split;
		if (!path || !isAbsolute(path)) return [];
		const pin = rest.find((field) => field.startsWith("sha256="))?.slice("sha256=".length).toLowerCase();
		const glob = rest.find((field) => field !== ALLOW_ANY_ARGS && !field.startsWith("sha256="));
		return [
			{
				path,
				...(pin === undefined ? {} : { sha256: pin }),
				...(glob === undefined ? {} : { glob }),
				allowAnyArgs: rest.includes(ALLOW_ANY_ARGS),
			},
		];
	});
}

function splitAllowlistLine(line: string): { path: string; rest: string[] } | undefined {
	const trimmed = line.trimStart();
	const fields = (text: string) => text.replace(/#.*$/, "").trim().split(/\s+/).filter(Boolean);
	if (!trimmed.startsWith('"')) {
		const [path, ...rest] = fields(trimmed);
		return path ? { path, rest } : undefined;
	}
	const quoted = /^"((?:[^"\\]|\\.)*)"(?=\s|$)/.exec(trimmed);
	if (!quoted) return undefined;
	return { path: quoted[1].replace(/\\(.)/g, "$1"), rest: fields(trimmed.slice(quoted[0].length)) };
}

function globMatches(glob: string, name: string): boolean {
	const pattern = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
	return new RegExp(`^${pattern}$`).test(name);
}

function real(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** True for a shell, interpreter, launcher, network, VCS or other general tool whose arguments can run code or send data anywhere. */
export function isGeneralTool(path: string): boolean {
	return GENERAL_TOOL.test(basename(path).replace(/\.exe$/i, ""));
}

const SCRIPT_RUNNER =
	/^(?:sh|bash|zsh|fish|dash|ksh|mksh|csh|tcsh|ash|python[\d.]*|pypy[\d.]*|node(?:js)?|bun|deno|perl[\d.]*|ruby[\d.]*|php[\d.]*|lua[\d.]*|tclsh[\d.]*|pwsh|osascript)$/i;

/** The interpreter a #! line names, with env and its flags skipped; undefined when there is no #! line. */
export function shebangInterpreter(bytes: Uint8Array): string | undefined {
	if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return undefined;
	const end = bytes.indexOf(0x0a);
	const words = new TextDecoder().decode(bytes.subarray(2, end === -1 ? Math.min(bytes.length, 256) : end)).trim().split(/\s+/);
	if (basename(words[0] ?? "") !== "env") return words[0];
	return words.slice(1).find((word) => !word.startsWith("-") && !word.includes("="));
}

/** True when running the file can run code or reach data its pinned bytes do not fix: a general tool by name or by #! line. */
function needsAnyArgs(command: string, resolved: string, bytes: Uint8Array): boolean {
	if (isGeneralTool(command) || isGeneralTool(resolved)) return true;
	const interpreter = shebangInterpreter(bytes);
	return interpreter !== undefined && isGeneralTool(interpreter) && !SCRIPT_RUNNER.test(basename(interpreter));
}

/** Resolves argv[0] to a real absolute path: a bare name through the daemon's own PATH, a path from the working directory. */
export function resolveExecutable(command: string, cwd: string, daemonPath = process.env.PATH ?? ""): string | undefined {
	if (command.includes("/") || command.includes("\\")) return real(resolve(cwd, command));
	const found = Bun.which(command, { PATH: daemonPath });
	return found ? real(found) : undefined;
}

/** Checks a command against the allowlist file for the given pw/ names; on success it gives the exact bytes it hashed, to run as they are. */
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
}): { ok: true; path: string; bytes: Uint8Array } | { ok: false; error: string } {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return {
			ok: false,
			error: `credentials exec runs commands with pw/ values only when ${file} lists them. The file does not exist. The person makes a small fixed wrapper script that the agent cannot write, then runs dg-skills credentials allow <script> [glob] and adds the line it prints.`,
		};
	}
	const resolved = resolveExecutable(command, cwd, daemonPath);
	if (!resolved) return { ok: false, error: `credentials exec could not find ${command} as an executable file.` };
	const entries = parseExecAllowlist(text).filter((candidate) => real(candidate.path) === resolved);
	const covering = (name: string) => entries.filter((entry) => !entry.glob || globMatches(entry.glob, name));
	if (!names.every((name) => covering(name).length))
		return {
			ok: false,
			error: `${resolved} is not listed in ${file} for ${names.join(", ")}. The person adds it there to allow it.`,
		};
	let bytes: Uint8Array;
	try {
		bytes = readFileSync(resolved);
	} catch {
		return { ok: false, error: `credentials exec could not read ${resolved}.` };
	}
	const hash = createHash("sha256").update(bytes).digest("hex");
	const pinned = (name: string) => covering(name).filter((entry) => entry.sha256 === hash);
	if (!names.every((name) => pinned(name).length))
		return {
			ok: false,
			error: names.some((name) => covering(name).every((entry) => entry.sha256 === undefined))
				? `${file} lists ${resolved} without a sha256 pin. Run dg-skills credentials allow ${resolved} and use the line it prints.`
				: `The sha256 of ${resolved} changed since ${file} pinned it, so credentials exec refuses it. The person checks the file, then pins it again with dg-skills credentials allow.`,
		};
	if (needsAnyArgs(command, resolved, bytes) && !names.every((name) => pinned(name).some((entry) => entry.allowAnyArgs)))
		return {
			ok: false,
			error: `${resolved} is a shell, interpreter or general tool whose arguments can run code or send data anywhere, so credentials exec refuses it with pw/ values even though ${file} lists it. Only a line with ${ALLOW_ANY_ARGS} allows it; prefer a small fixed wrapper script.`,
		};
	return { ok: true, path: resolved, bytes };
}
