import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { selfCommand, shellCommand } from "../utils/self-command";
import { main as backgroundMain } from "./background";
import type { Backend, ProxyOptions } from "./index";
import {
	BACKENDS,
	checkPreflight,
	classifyFailure,
	findBackend,
	proxyDir,
	resolvePersona,
	runBackend,
	withPersona,
} from "./index";

const VALUE_FLAGS = new Set([
	"model",
	"effort",
	"subagent",
	"spec",
	"slice",
	"cwd",
	"resume",
	"prompt",
	"prompt-file",
]);
const SWITCHES = new Set(["--help", "-h", "--list-backends", "--plan", "-p"]);

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
			if (!VALUE_FLAGS.has(name)) throw new Error(`unknown flag ${arg}`);
			const value = argv[i + 1];
			if (value === undefined || SWITCHES.has(value) || (value.startsWith("--") && VALUE_FLAGS.has(value.slice(2))))
				throw new Error(`${arg} requires a value`);
			flags[name] = value;
			i++;
			continue;
		}
		positionals.push(arg);
	}

	return { positionals, flags, listBackends, plan, help };
}

/** Dispatch proxy argv explicitly; emit result JSON and preserve backend failures as process exit statuses. */
export async function main(argv: string[]): Promise<number | void> {
	if (argv[0] === "background") return backgroundMain(argv.slice(1));
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs(argv);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
	const { positionals, flags, listBackends, plan, help } = parsed;
	if (help) {
		console.log(
			"Usage: dg-skills proxy <backend> (--prompt <text> | --prompt-file <path>) [--plan|-p] [flags]\n\nFlags: --list-backends, --model <model>, --effort <effort>, --cwd <path>, --resume <id>, --subagent <name>, --spec <plan>, --slice <id>\nBackground commands (see dg-skills bg): run, list, prune, status, cancel, kill, update, drain",
		);
		return 0;
	}

	if (listBackends) {
		console.log(Object.keys(BACKENDS).join("\n"));
		return 0;
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

	const backend = findBackend(backendName);
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

	let result: Awaited<ReturnType<typeof runBackend>>;
	try {
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

/** Write the persona-briefed prompt to a plan file and print the background launch command without running the backend. */
async function runPlan(
	backendName: string,
	backend: Backend,
	opts: ProxyOptions,
): Promise<void> {
	const preflight = checkPreflight(backendName, backend);
	if (preflight.missing) {
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

	const backendArgs = ["proxy", backendName, "--prompt-file", planFile];
	if (opts.model) backendArgs.push("--model", opts.model);
	if (opts.effort) backendArgs.push("--effort", opts.effort);
	if (opts.cwd) backendArgs.push("--cwd", opts.cwd);
	const innerCommand = shellCommand(selfCommand(backendArgs));
	const command = shellCommand(
		selfCommand(["bg", "run", innerCommand]),
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
