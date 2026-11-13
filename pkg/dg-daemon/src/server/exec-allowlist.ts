import { readFileSync, realpathSync } from "node:fs";
import { EXEC_ALLOW_ANY_ARGS as ALLOW_ANY_ARGS, fileSha256 } from "@dg/common/node";
import { basename, isAbsolute, resolve } from "node:path";

/** One allowlist line: an absolute executable, its sha256 pin, an optional pw/ name glob, and the any-args opt-in. */
export type ExecAllowEntry = { path: string; sha256?: string; glob?: string; allowAnyArgs: boolean };


const GENERAL_TOOL =
	/^(?:sh|bash|zsh|fish|dash|ksh|mksh|csh|tcsh|ash|busybox|toybox|env|python[\d.]*|pypy[\d.]*|node(?:js)?|bun|bunx|deno|npx|npm|pnpm|yarn|perl[\d.]*|ruby[\d.]*|php[\d.]*|lua[\d.]*|tclsh[\d.]*|osascript|pwsh|powershell|cmd|xargs|parallel|nohup|timeout|nice|ionice|setsid|stdbuf|sudo|doas|su|runuser|chroot|unshare|script|watch|find|awk|gawk|mawk|nawk|sed|expect|ssh|scp|sftp|rsync|time|curl|wget|httpie|http|https|nc|ncat|netcat|socat|telnet|ftp|git|hg|svn|tar|zip|unzip|make|cmake|docker|podman|kubectl|vi|vim|nvim|emacs|nano|less|more|man|tee|dd|cp|mv|install|openssl|gpg|jq|aws|gcloud|az|gh|glab)$/i;

/** Parses the allowlist text: one entry per line, # starts a comment. */
export function parseExecAllowlist(text: string): ExecAllowEntry[] {
	return text.split(/\r?\n/).flatMap((line) => {
		const fields = line.replace(/#.*$/, "").trim().split(/\s+/).filter(Boolean);
		const [path, ...rest] = fields;
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
			error: `credentials exec runs commands with pw/ values only when ${file} lists them. The file does not exist. The person makes a small fixed wrapper script that the agent cannot write, then runs dg-skills credentials allow <script> [glob] and adds the line it prints.`,
		};
	}
	const resolved = resolveExecutable(command, cwd, daemonPath);
	if (!resolved) return { ok: false, error: `credentials exec could not find ${command} as an executable file.` };
	const entries = parseExecAllowlist(text).filter((candidate) => real(candidate.path) === resolved);
	const covers = (entry: ExecAllowEntry, name: string) => !entry.glob || globMatches(entry.glob, name);
	if (!names.every((name) => entries.some((entry) => covers(entry, name))))
		return {
			ok: false,
			error: `${resolved} is not listed in ${file} for ${names.join(", ")}. The person adds it there to allow it.`,
		};
	const used = entries.filter((entry) => names.some((name) => covers(entry, name)));
	const hash = fileSha256(resolved);
	if (!hash || used.some((entry) => entry.sha256 !== hash))
		return {
			ok: false,
			error: used.some((entry) => entry.sha256 === undefined)
				? `${file} lists ${resolved} without a sha256 pin. Run dg-skills credentials allow ${resolved} and use the line it prints.`
				: `The sha256 of ${resolved} changed since ${file} pinned it, so credentials exec refuses it. The person checks the file, then pins it again with dg-skills credentials allow.`,
		};
	if (isGeneralTool(resolved) && !names.every((name) => entries.some((entry) => covers(entry, name) && entry.allowAnyArgs)))
		return {
			ok: false,
			error: `${resolved} is a shell, interpreter or general tool whose arguments can run code or send data anywhere, so credentials exec refuses it with pw/ values even though ${file} lists it. Only a line with ${ALLOW_ANY_ARGS} allows it; prefer a small fixed wrapper script.`,
		};
	return { ok: true, path: resolved };
}
