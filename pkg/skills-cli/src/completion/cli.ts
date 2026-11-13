import { type CompletionShell, completionScript } from "@dg/common/completion";
import { removeCompletions, writeCompletions } from "./files";

export type CompletionOptions = { install?: boolean; uninstall?: boolean };

/** Prints a completion script, or writes or removes the completion files of every dg program. */
export function runCompletion(shell: CompletionShell | undefined, opts: CompletionOptions): number {
	if (opts.install && opts.uninstall) {
		process.stderr.write("dg-skills completion: pass only one of --install and --uninstall\n");
		return 2;
	}
	if (opts.install) {
		if (writeCompletions().length === 0) console.log("dg: shell completion is already current");
		return 0;
	}
	if (opts.uninstall) {
		if (removeCompletions().length === 0) console.log("dg: no shell completion files to remove");
		return 0;
	}
	if (!shell) {
		process.stderr.write("dg-skills completion: name a shell (bash, zsh or fish), or pass --install or --uninstall\n");
		return 2;
	}
	process.stdout.write(completionScript(shell, "dg-skills"));
	return 0;
}
