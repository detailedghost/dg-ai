import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { selfCommand, shellCommand } from "../utils/self-command";
import { main as backgroundMain } from "./background";
import type { Backend } from "./index";
import {
	BACKENDS,
	checkPreflight,
	classifyFailure,
	proxyDir,
	resolvePersona,
	runBackend,
	withPersona,
} from "./index";

function parseArgs(argv: string[]) {
	const flags: Record<string, string> = {};
	let listBackends = false;
	let plan = false;
	let help = false;
	const positionals: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--list-backends") {
			listBackends = true;
			continue;
		}
		if (arg === "--plan" || arg === "-p") {
			plan = true;
			continue;
		}
		if (arg.startsWith("--")) {
			const name = arg.slice(2);
			flags[name] = argv[++i];
			continue;
		}
		positionals.push(arg);
	}

	return { positionals, flags, listBackends, plan, help };
}

/** Dispatch proxy argv explicitly; emit result JSON and preserve backend failures as process exit statuses. */
export async function main(argv: string[]): Promise<number | void> {
	if (argv[0] === "background") return backgroundMain(argv.slice(1));
	const { positionals, flags, listBackends, plan, help } = parseArgs(argv);
	if (help) {
		console.log(
			"Usage: dg-skills proxy <backend> (--prompt <text> | --prompt-file <path>) [--plan|-p] [flags]\n\nFlags: --list-backends, --model <model>, --effort <effort>, --cwd <path>, --resume <id>, --subagent <name>, --spec <plan>, --slice <id>\nInternal background commands: run, list, status, update, drain, cancel",
		);
		return 0;
	}

	if (listBackends) {
		console.log(Object.keys(BACKENDS).join("\n"));
		process.exit(0);
	}

	const backendName = positionals[0];
	const {
		model,
		effort,
		subagent,
		spec,
		slice,
		cwd,
		resume,
		"prompt-file": promptFile,
	} = flags;

	let prompt = flags.prompt;
	if (!prompt && promptFile) {
		try {
			prompt = readFileSync(promptFile, "utf8");
		} catch (err) {
			console.error(
				`failed to read --prompt-file ${promptFile}: ${err instanceof Error ? err.message : String(err)}`,
			);
			process.exit(1);
		}
	}

	if (!backendName) {
		console.error(
			"usage: dg-skills proxy <backend> (--prompt <text> | --prompt-file <path>) [--plan|-p] [flags]",
		);
		process.exit(1);
	}
	if (!prompt) {
		console.error("--prompt or --prompt-file is required");
		process.exit(1);
	}

	const backend = BACKENDS[backendName];
	if (!backend) {
		console.error(
			`unknown backend "${backendName}", known: ${Object.keys(BACKENDS).join(", ")}`,
		);
		process.exit(1);
	}

	if (plan) {
		await runPlan(backendName, backend, {
			prompt,
			subagent,
			spec,
			slice,
			model,
			effort,
			cwd,
		});
		return;
	}

	const preflight = checkPreflight(backendName, backend);
	if (!preflight.available) {
		console.log(JSON.stringify(preflight.missing));
		process.exit(1);
	}

	/**
	 * Persona resolution and the spawn itself can both throw (missing agent
	 * file, invalid spec frontmatter, a binary vanishing after
	 * checkPreflight). None of that may escape as an unhandled rejection.
	 * A backgrounded run has nobody watching stderr live, so this must also
	 * leave one parseable JSON line on stdout — same as the two expected
	 * failure shapes below — not just a plain stderr message.
	 */
	let result: Awaited<ReturnType<typeof runBackend>>;
	try {
		// A resumed session already has its persona context; re-injecting it
		// would just re-brief a role the model already committed to.
		let finalPrompt = prompt;
		if (!resume) {
			const persona = await resolvePersona({ subagent, spec, slice });
			finalPrompt = withPersona(persona, prompt);
		}

		result = await runBackend(backendName, backend, {
			prompt: finalPrompt,
			model,
			effort,
			cwd,
			resume,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(message);
		console.log(JSON.stringify({ exitCode: 1, error: message }));
		process.exit(1);
	}

	if (result.exitCode === 0) {
		console.log(
			JSON.stringify({
				sessionId: result.sessionId,
				message: result.message,
				logFile: result.logFile,
				exitCode: 0,
			}),
		);
		return;
	}

	const likelyCause = classifyFailure(
		`${result.message}\n${result.stderrTail}`,
	);
	console.log(
		JSON.stringify({
			exitCode: result.exitCode,
			stderrTail: result.stderrTail,
			likelyCause,
			logFile: result.logFile,
		}),
	);
	process.exit(result.exitCode);
}

/**
 * `--plan`/`-p`: build the same persona-injected prompt a real run would send,
 * but stop short of spawning the backend. Writes the prompt to a scratch file
 * (it's too large to shell-quote inline) and prints the exact background
 * command to launch it later — the Change-1 background convention, just not
 * launched yet. A missing backend binary is a note, not a block: the plan is
 * still useful so the human can install the backend before running it.
 */
async function runPlan(
	backendName: string,
	backend: Backend,
	opts: {
		prompt: string;
		subagent?: string;
		spec?: string;
		slice?: string;
		model?: string;
		effort?: string;
		cwd?: string;
	},
): Promise<void> {
	const preflight = checkPreflight(backendName, backend);
	if (!preflight.available && preflight.missing) {
		console.error(
			`proxy: note - ${preflight.missing.bin} not found on PATH yet (${preflight.missing.installHint}); the plan is still written.`,
		);
	}

	let finalPrompt: string;
	try {
		const persona = await resolvePersona({
			subagent: opts.subagent,
			spec: opts.spec,
			slice: opts.slice,
		});
		finalPrompt = withPersona(persona, opts.prompt);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(message);
		console.log(JSON.stringify({ exitCode: 1, error: message }));
		process.exit(1);
	}

	const planFile = `${proxyDir()}/${Date.now()}-${randomUUID()}-${backendName}.plan.md`;
	writeFileSync(planFile, finalPrompt, { flag: "wx", mode: 0o600 });

	// Persona is already baked into planFile — passing --subagent/--spec/--slice
	// again on launch would re-resolve and double-wrap it.
	const backendArgs = ["proxy", backendName, "--prompt-file", planFile];
	if (opts.model) backendArgs.push("--model", opts.model);
	if (opts.effort) backendArgs.push("--effort", opts.effort);
	if (opts.cwd) backendArgs.push("--cwd", opts.cwd);
	const innerCommand = shellCommand(selfCommand(backendArgs));
	const command = shellCommand(
		selfCommand(["proxy", "background", "run", innerCommand]),
	);

	console.error(`proxy: plan written -> ${planFile}`);
	console.error(`proxy: run in background with:\n  ${command}`);
	console.log(
		JSON.stringify(
			{ plan: true, backend: backendName, planFile, command },
			null,
			2,
		),
	);
}
