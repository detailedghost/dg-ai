import { Command, CommanderError } from "commander";
import type { BatchOpenOptions } from "../batch-open/cli";
import type { LaunchOptions } from "../launch/cli";
import { assertExtensionInstalled } from "../utils/cli-only";
import { addExtOption } from "../utils/ext-flag";
import type { ClientEnv } from "./core/spec";

const HELP_CODES = new Set(["commander.helpDisplayed", "commander.help"]);

/** The batch-open and launch verbs as commander definitions; each action reports its exit code through `setCode`. */
export function tabVerbsProgram(setCode: (code: number) => void = () => {}): Command {
	const program = new Command("pw");
	addExtOption(
		program
			.command("batch-open")
			.description("open a batch of PRs/URLs in the default browser")
			.argument("<refs...>", "URL | owner/repo#num | alias#num | bare num")
			.option("-R, --repo <owner/repo>", "default repo for bare PR numbers")
			.option("-g, --group <name>", "tab group name (needs --ext)")
			.option("--print", "print the URLs instead of opening them"),
	).action(async (refs: string[], opts: BatchOpenOptions) => {
		if (opts.ext) assertExtensionInstalled("dg-skills pw batch-open");
		const { runBatchOpen } = await import("../batch-open/cli");
		await runBatchOpen(refs, opts);
	});
	addExtOption(program.command("launch"))
		.description(
			"cold-start a Chromium browser with the extension side-loaded + open a batch (needs --ext)",
		)
		.argument("[refs...]", "URL | owner/repo#num | alias#num | bare num")
		.option("-b, --browser <key>", "browser key (see --list)")
		.option("-R, --repo <owner/repo>", "default repo for bare PR numbers")
		.option("-g, --group <name>", "tab group name", "PRs")
		.option("--list", "list detected browsers and exit")
		.option("--dry-run", "print the launch command without running it")
		.action(async (refs: string[], opts: LaunchOptions) => {
			assertExtensionInstalled("dg-skills pw launch");
			const { runLaunch } = await import("../launch/cli");
			setCode(await runLaunch(refs, opts));
		});
	return program;
}

/** Runs `pw batch-open` or `pw launch`; argv may carry flags such as --ext before the verb. */
export async function runTabVerb(
	verb: string,
	argv: readonly string[],
	env: ClientEnv,
): Promise<number> {
	let code = 0;
	const program = tabVerbsProgram((value) => {
		code = value;
	});
	const write = (print: (text: string) => void) => (text: string) =>
		print(text.replace(/\n$/, ""));
	for (const command of [program, ...program.commands])
		command
			.exitOverride()
			.configureOutput({ writeOut: write(env.out), writeErr: write(env.err) });
	const rest = [...argv];
	rest.splice(rest.indexOf(verb), 1);
	try {
		await program.parseAsync([verb, ...rest], { from: "user" });
		return code;
	} catch (error) {
		if (error instanceof CommanderError) return HELP_CODES.has(error.code) ? 0 : 2;
		env.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
