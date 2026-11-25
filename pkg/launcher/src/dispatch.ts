import { buildVersion } from "@dg/common/build-version";
import type { ProgramName } from "@dg/common/node/program";

type Program = { main(argv: string[]): Promise<number> };

const PROGRAMS: Record<ProgramName, () => Promise<Program>> = {
	"dg-skills": () => import("./programs/skills"),
	"dg-agent": () => import("./programs/agent"),
	"dg-daemon": () => import("./programs/daemon"),
	dg: () => import("./programs/dg"),
};

const NEW_FORM: Record<Exclude<ProgramName, "dg">, string> = { "dg-skills": "dg", "dg-agent": "dg agent", "dg-daemon": "dg daemon" };

function isOldName(name: string | undefined): name is Exclude<ProgramName, "dg"> {
	return name !== undefined && Object.hasOwn(NEW_FORM, name);
}

const removed = (name: Exclude<ProgramName, "dg">, args: readonly string[]): string =>
	`dg: the ${name} command is removed; run ${[NEW_FORM[name], ...args].join(" ")}\n`;

const JIT_ENV = "BUN_JSC_useJIT";
const REEXEC_MARK = "DG_JIT_REEXEC";
const KEEP_JIT = "DG_JIT";

type Execve = (file: string, args: string[], env: Record<string, string | undefined>) => void;

const FFI_COMMANDS: ReadonlySet<string> = new Set(["jot", "stat", "install", "update", "upgrade", "extension"]);
const GROUP_WORDS: ReadonlySet<string> = new Set(["dg", "skills", "dg-skills"]);

function commandWords(argv: readonly string[]): string[] {
	return argv.filter((word) => !GROUP_WORDS.has(word));
}

/** True for a command that reaches bun:ffi, which needs the JIT. */
function needsFfi(argv: readonly string[]): boolean {
	const command = commandWords(argv)[0];
	return command !== undefined && FFI_COMMANDS.has(command);
}

/** True for a command whose RSS stays in budget with the JIT on, so the re-exec would only add time. */
function staysInBudgetWithJit(argv: readonly string[]): boolean {
	const bridged = isOldName(argv[0]) || argv[0] === "dg";
	const [first, second] = bridged ? argv.slice(1) : argv;
	return first === "--version" || (first === "hooks" && second === "run");
}

/** Re-executes dg once with the JSC JIT off; the pid stays the same, and DG_JIT=1 skips it. */
export async function reexecWithoutJit(
	argv: readonly string[],
	env: Record<string, string | undefined> = process.env,
	execve: Execve | undefined = process.platform === "win32" ? undefined : process.execve?.bind(process),
): Promise<void> {
	if (env[REEXEC_MARK] !== undefined && env[JIT_ENV] === "0") {
		delete env[JIT_ENV];
		delete env[REEXEC_MARK];
		return;
	}
	if (typeof execve !== "function" || env[JIT_ENV] !== undefined || env[KEEP_JIT] === "1" || needsFfi(argv) || staysInBudgetWithJit(argv)) return;
	try {
		const { isCompiled } = await import("@dg/common/node/program");
		const execArgv = [process.argv0, ...(isCompiled() ? [] : [Bun.main]), ...argv];
		execve(process.execPath, execArgv, { ...env, [JIT_ENV]: "0", [REEXEC_MARK]: "1" });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		process.stderr.write(`dg: could not restart without the JIT, so it stays on: ${reason}\n`);
	}
}

function invokedName(argv0: string | undefined): string | undefined {
	return argv0
		?.split(/[\\/]/)
		.at(-1)
		?.replace(/\.exe$/i, "");
}

export function isVersionOnly(argv: readonly string[]): boolean {
	return argv.length === 1 && argv[0] === "--version";
}

function printVersion(): Promise<number> {
	return new Promise((resolve) => {
		process.stdout.write(`${buildVersion()}\n`, () => resolve(0));
	});
}

/** Answers --version, hooks and completion without the flat route tree; undefined means the full program must run. */
async function runFast(args: readonly string[]): Promise<number | undefined> {
	if (isVersionOnly(args)) return printVersion();
	if (args[0] !== "hooks" && args[0] !== "__complete") return undefined;
	const { fastRoute, runFastRoute } = await import("@dg/dg/fast-route");
	switch (fastRoute(args)) {
		case "hooks": {
			const { normalizeDgHome } = await import("@dg/common/node/dg-paths");
			normalizeDgHome();
			return runFastRoute("hooks", args);
		}
		case "completion": {
			const words = args.slice(1);
			if (words.length < 2) return undefined;
			const { completeFast } = await import("@dg/skills-cli/completion/fast");
			const lines = completeFast(words);
			if (lines.length === 0) return undefined;
			process.stdout.write(`${lines.join("\n")}\n`);
			return 0;
		}
		default:
			return undefined;
	}
}

/** Runs dg with `argv`; an old program name as first word is the 6.3 bridge, as invoked name it exits 1. */
export async function dispatch(argv: readonly string[], argv0?: string): Promise<number> {
	const invoked = invokedName(argv0);
	if (isOldName(invoked)) {
		process.stderr.write(removed(invoked, argv));
		return 1;
	}
	const [first, ...rest] = argv;
	const bridge = isOldName(first) || first === "dg";
	const name: ProgramName = bridge ? (first as ProgramName) : "dg";
	const args = bridge ? rest : [...argv];
	if (isOldName(name)) process.stderr.write(removed(name, args));
	if (!isOldName(first)) {
		const code = await runFast(args);
		if (code !== undefined) return code;
	}
	const { normalizeDgHome } = await import("@dg/common/node/dg-paths");
	normalizeDgHome();
	if (isVersionOnly(args)) return printVersion();
	const { setProgramName } = await import("@dg/common/node/program");
	setProgramName(name);
	if (bridge) {
		const { finishLegacyUpgrade } = await import("@dg/skills-cli/finish-upgrade");
		await finishLegacyUpgrade(name, args);
	}
	const { main } = await PROGRAMS[name]();
	return main(args);
}

