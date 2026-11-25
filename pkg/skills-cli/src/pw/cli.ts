import { DgCliError } from "@dg/common";
import { readDgToml, readPidFile, resolveCliSession, resolveDgPaths } from "@dg/common/node";
import { connectedExtensionVersion } from "../doctor/probes";
import { isCliOnly } from "../utils/cli-only";
import {
	autoExtArgv,
	forcedBrowserMode,
	resolveBrowserMode,
	withoutLocalFlag,
} from "./browser-mode";
import { COMMANDS, type CommandEntry } from "./commands/index";
import {
	commandName,
	normalize,
	optionArgs,
	parse,
	UsageError,
} from "./core/args";
import { BrowserMissingError } from "./core/browser";
import type { ExtDeps } from "./ext";
import { bunVersionError } from "./core/bun-version";
import { defaultEnv, forward, VERSION } from "./core/client";
import { commandHelp, indexHelp } from "./core/help";
import type { ClientEnv, ClientHandler } from "./core/spec";

export const RUN_CODE_MOVED =
	"run-code moved to pw-code (it needs your approval each time).";

type ExtensionProbe = { session(): Promise<unknown>; version(): Promise<string | null> };

const LIVE_PROBE: ExtensionProbe = {
	session: () => resolveCliSession(),
	async version() {
		const handle = readPidFile(resolveDgPaths());
		return handle ? connectedExtensionVersion(handle) : null;
	},
};

/** True only when a daemon session exists and the daemon reports a paired extension that has contacted it. */
export async function extensionConnected(probe: ExtensionProbe = LIVE_PROBE): Promise<boolean> {
	if (isCliOnly()) return false;
	try {
		await probe.session();
		return (await probe.version()) !== null;
	} catch {
		return false;
	}
}

type Route = { argv: string[]; ext: boolean };

async function chooseBrowser(
	original: readonly string[],
	env: ClientEnv,
	extConnected: () => Promise<boolean>,
): Promise<Route | number> {
	const { argv, local } = withoutLocalFlag(original);
	const verb = commandName(argv);
	const flags = { local, ext: optionArgs(argv).includes("--ext") };
	const needsConfig =
		!flags.local && !flags.ext && !["ext", "local"].includes(process.env["DG_BROWSER"] ?? "");
	try {
		const config = needsConfig ? readDgToml(process.env).browser.mode : undefined;
		const input = { flags, env: process.env, config, extConnected: false, verb };
		const forced = forcedBrowserMode(input) !== undefined;
		const mapped = autoExtArgv(argv);
		const probe = !forced && mapped !== undefined;
		const decision = resolveBrowserMode({
			...input,
			fits: mapped !== undefined,
			extConnected: probe && (await extConnected()),
		});
		if (flags.ext && !flags.local && decision.mode === "local") {
			env.err(`pw ${verb} runs only in local mode. Next: run it without --ext.`);
			return 2;
		}
		return { argv: decision.mode === "ext" && !forced && mapped ? mapped : argv, ext: decision.mode === "ext" };
	} catch (error) {
		if (!(error instanceof DgCliError)) throw error;
		env.err(error.message);
		return 1;
	}
}

export async function main(
	argv: readonly string[],
	env: ClientEnv = defaultEnv(),
	commands: readonly CommandEntry[] = COMMANDS,
	extConnected: () => Promise<boolean> = extensionConnected,
	extDeps?: ExtDeps,
): Promise<number> {
	if (argv[0] === "daemon") {
		await (await import("./daemon")).runDaemon(argv[1]);
		return new Promise<number>(() => undefined);
	}
	const versionError = bunVersionError(Bun.version);
	if (versionError) {
		env.err(versionError);
		return 1;
	}
	const verb = commandName(argv);
	if (verb === "batch-open" || verb === "launch")
		return (await import("./tab-verbs")).runTabVerb(verb, argv, env);
	const route = await chooseBrowser(argv, env, extConnected);
	if (typeof route === "number") return route;
	if (route.ext) return (await import("./ext")).runExt(route.argv, env, extDeps);
	try {
		const args = normalize(route.argv);
		const name = commandName(args);
		const options = optionArgs(args);
		if (options.includes("--version")) {
			env.out(`pw ${VERSION}`);
			return 0;
		}
		if (!name) {
			env.out(indexHelp(commands.map((entry) => entry.spec)));
			return options.includes("--help") ? 0 : 2;
		}
		if (name === "run-code") {
			env.err(RUN_CODE_MOVED);
			return 2;
		}
		const entry = commands.find((candidate) => candidate.spec.name === name);
		if (!entry) {
			env.err(`Unknown command: ${name}\nRun: pw --help`);
			return 2;
		}
		if (options.includes("--help")) {
			env.out(commandHelp(entry.spec));
			return 0;
		}

		const parsed = parse(args, entry.spec);
		if (entry.spec.side === "client") {
			const handler = (await entry.load()).default as ClientHandler;
			return await handler(parsed, env);
		}

		return await forward(parsed, "run", args, env);
	} catch (error) {
		if (error instanceof UsageError || error instanceof BrowserMissingError) {
			env.err(error.message);
			return error.exitCode;
		}
		env.err(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
