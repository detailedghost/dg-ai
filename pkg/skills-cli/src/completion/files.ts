import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { COMPLETION_SHELLS, type CompletionShell, completionScript } from "@dg/common/completion";
import { writeFileAtomic } from "@dg/common/node";
import { PROGRAM_NAMES } from "@dg/common/node/program";

export type CompletionSeams = {
	env?: Record<string, string | undefined>;
	home?: string;
	platform?: NodeJS.Platform;
};

export type CompletionFile = { program: string; shell: CompletionShell; path: string };
export type CompletionState = "current" | "stale" | "missing";

type Dirs = Record<CompletionShell, string>;

function shellDirs({ env = process.env, home = homedir() }: CompletionSeams): Dirs {
	const root = (name: string, fallback: string): string => {
		const value = env[name];
		return value && isAbsolute(value) ? value : fallback;
	};
	const dgHome = env.DG_HOME;
	const data = dgHome ? join(dgHome, "share") : root("XDG_DATA_HOME", join(home, ".local", "share"));
	const config = dgHome ? join(dgHome, "config") : root("XDG_CONFIG_HOME", join(home, ".config"));
	return {
		bash: join(data, "bash-completion", "completions"),
		zsh: join(data, "zsh", "site-functions"),
		fish: join(config, "fish", "completions"),
	};
}

const fileName = (shell: CompletionShell, program: string): string =>
	shell === "zsh" ? `_${program}` : shell === "fish" ? `${program}.fish` : program;

/** Every completion file dg writes; none on Windows. */
export function completionFiles(seams: CompletionSeams = {}): CompletionFile[] {
	if ((seams.platform ?? process.platform) === "win32") return [];
	const dirs = shellDirs(seams);
	return PROGRAM_NAMES.flatMap((program) =>
		COMPLETION_SHELLS.map((shell) => ({ program, shell, path: join(dirs[shell], fileName(shell, program)) })),
	);
}

function readOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function completionState(file: CompletionFile): CompletionState {
	const text = readOrUndefined(file.path);
	if (text === undefined) return "missing";
	return text === completionScript(file.shell, file.program) ? "current" : "stale";
}

/** The one line that tells a zsh user to put the dg completion folder on fpath, or undefined when not needed. */
export function zshHint(dir: string, env: Record<string, string | undefined> = process.env): string | undefined {
	if (!Bun.which("zsh", { PATH: env.PATH ?? "" })) return undefined;
	if ((env.FPATH ?? "").split(":").includes(dir)) return undefined;
	return `zsh: add  fpath=(${dir} $fpath)  to ~/.zshrc before compinit to turn on dg completion`;
}

/** Writes every completion file that is missing or stale; returns the paths it wrote. */
export function writeCompletions(seams: CompletionSeams = {}, log: (line: string) => void = console.log): string[] {
	const written = completionFiles(seams).flatMap((file) => {
		if (completionState(file) === "current") return [];
		mkdirSync(dirname(file.path), { recursive: true });
		writeFileAtomic(file.path, completionScript(file.shell, file.program));
		return [file];
	});
	if (written.length > 0) log(`dg: shell completion written for bash, zsh and fish (${written.length} file(s))`);
	const zsh = written.find((file) => file.shell === "zsh");
	const hint = zsh && zshHint(dirname(zsh.path), seams.env ?? process.env);
	if (hint) log(hint);
	return written.map((file) => file.path);
}

/** Removes the completion files that dg wrote; a file that does not call back into its program stays. */
export function removeCompletions(seams: CompletionSeams = {}, log: (line: string) => void = console.log): string[] {
	return completionFiles(seams).flatMap((file) => {
		const text = readOrUndefined(file.path);
		if (text === undefined || !text.includes(`${file.program} __complete`)) return [];
		rmSync(file.path, { force: true });
		log(`dg: removed ${file.path}`);
		return [file.path];
	});
}
