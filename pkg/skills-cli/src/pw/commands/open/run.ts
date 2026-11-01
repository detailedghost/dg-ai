import path from "node:path";
import { isWSL } from "@dg/common/node";
import { stringFlag, UsageError } from "../../core/args";
import {
	BrowserMissingError,
	type LaunchPick,
	type LaunchSpec,
	pickLaunch,
} from "../../core/browser";
import { downloadedChromium } from "../../core/downloaded";
import { ensurePrivateDir } from "../../core/files";
import { launch, releaseKey, runRemote } from "../../core/launch";
import { defaultProfileDir } from "../../core/profiles";
import {
	BROWSERS,
	type BrowserName,
	defaultOutputDir,
	sessionKey,
	socketPathFor,
} from "../../core/registry";
import type { ClientEnv, ClientHandler, ParsedArgs } from "../../core/spec";
import { restoreState } from "../../core/state-restore";
import {
	importLegacyOnce,
	load,
	type StorageState,
	statePathFor,
	validateName,
} from "../../core/states";
import {
	assertSafeProfileDir,
	closeWindowsBrowser,
	exePath,
	isWindowsBrowser,
	isWindowsPath,
	startWindowsBrowser,
	WINDOWS_ONLY_MESSAGE,
	windowsProfileDir,
	wslToWindowsPath,
} from "../../core/windows";

export function parseSessionDepth(
	value: string | undefined,
): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
		throw new UsageError(
			`Invalid --depth '${value}': use a non-negative integer`,
		);
	return Number(value);
}

function parseBrowser(args: ParsedArgs): BrowserName {
	const browser = stringFlag(args, "browser") ?? "chrome";
	const match = BROWSERS.find((known) => known === browser);
	if (!match)
		throw new UsageError(
			`Unsupported browser '${browser}': use ${BROWSERS.join(", ")}`,
		);
	return match;
}

export const WSL_HEADED_WARNING =
	"experimental: headed browser inside WSL (WSLg)";

export type WslPlan =
	| { mode: "windows" }
	| { mode: "local"; headless: boolean; warning?: string };

export function wslPlan(
	flags: ParsedArgs["flags"],
	windowsBrowserPresent: boolean,
): WslPlan {
	if (flags["windows"] === true) return { mode: "windows" };
	if (flags["wsl-headed"] === true)
		return { mode: "local", headless: false, warning: WSL_HEADED_WARNING };
	if (flags["browser"] !== undefined) return { mode: "local", headless: true };
	return windowsBrowserPresent
		? { mode: "windows" }
		: { mode: "local", headless: true };
}

export type OpenDeps = {
	isWSL(): boolean;
	windowsBrowserPresent(): boolean;
	pickLaunch(): LaunchPick;
	downloadedChromium(): string | null;
	startDaemon: typeof launch;
	startWindowsBrowser: typeof startWindowsBrowser;
	closeWindowsBrowser: typeof closeWindowsBrowser;
	windowsProfileDir: typeof windowsProfileDir;
};

const DEFAULT_DEPS: OpenDeps = {
	isWSL,
	windowsBrowserPresent: () =>
		exePath("chrome") !== null || exePath("msedge") !== null,
	pickLaunch: () => pickLaunch(),
	downloadedChromium: () => downloadedChromium()?.executablePath ?? null,
	startDaemon: launch,
	startWindowsBrowser,
	closeWindowsBrowser,
	windowsProfileDir,
};

type Seed = { name: string; state: StorageState };

function readSeed(args: ParsedArgs, env: ClientEnv): Seed | undefined {
	const name = stringFlag(args, "from");
	if (name === undefined) return undefined;
	validateName(name);
	importLegacyOnce(env.out);
	return { name, state: load(name) };
}

async function launchSeeded(
	spec: LaunchSpec,
	url: string | undefined,
	env: ClientEnv,
	seed: Seed | undefined,
	deps: OpenDeps,
	onFailure?: () => Promise<unknown>,
): Promise<number> {
	if (!seed) return deps.startDaemon(spec, url, env, onFailure);
	if (spec.scratch) {
		return deps.startDaemon(
			{ ...spec, storageState: statePathFor(seed.name) },
			url,
			env,
			onFailure,
		);
	}
	const opened = await deps.startDaemon(spec, undefined, env, onFailure);
	if (opened !== 0) return opened;
	const restored = await restoreState(spec, seed.name, seed.state, env);
	if (restored !== 0 || !url) return restored;
	return runRemote(spec, ["goto", url], env);
}

function baseSpec(
	args: ParsedArgs,
	env: ClientEnv,
	key: string,
	scratch: boolean,
): Omit<LaunchSpec, "browser" | "mode" | "profileDir"> {
	const out = stringFlag(args, "out");
	const outputDir = out ? path.resolve(env.cwd, out) : defaultOutputDir();
	ensurePrivateDir(outputDir);
	const depth = parseSessionDepth(stringFlag(args, "depth"));
	return {
		name: args.session,
		key,
		socketPath: socketPathFor(key),
		cwd: env.cwd,
		outputDir,
		headless: args.flags["headless"] === true,
		scratch,
		codegen: args.codegen,
		...(depth === undefined ? {} : { snapshotDepth: depth }),
	};
}

function windowsProfileOverride(
	args: ParsedArgs,
	env: ClientEnv,
): string | undefined {
	const profile = stringFlag(args, "profile");
	if (!profile) return undefined;
	const windowsProfile = isWindowsPath(profile)
		? profile
		: wslToWindowsPath(path.resolve(env.cwd, profile));
	assertSafeProfileDir(windowsProfile);
	return windowsProfile;
}

async function openWindows(
	args: ParsedArgs,
	env: ClientEnv,
	browser: BrowserName,
	deps: OpenDeps,
): Promise<number> {
	if (!isWindowsBrowser(browser)) throw new UsageError(WINDOWS_ONLY_MESSAGE);
	if (args.flags["scratch"] === true)
		throw new UsageError("--windows does not support --scratch");
	const profileOverride = windowsProfileOverride(args, env);
	const seed = readSeed(args, env);

	const key = sessionKey({ name: args.session, scratch: false });
	const refused = await releaseKey(
		{ key, scratch: false },
		env,
		deps.closeWindowsBrowser,
	);
	if (refused !== null) return refused;
	const base = baseSpec(args, env, key, false);

	let windows: Awaited<ReturnType<OpenDeps["startWindowsBrowser"]>>;
	try {
		const profileDir =
			profileOverride ?? (await deps.windowsProfileDir(args.session));
		windows = await deps.startWindowsBrowser({
			browser,
			profileDir,
			headless: args.flags["headless"] === true,
		});
	} catch (error) {
		env.err(
			`### Error\n${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}

	const spec: LaunchSpec = {
		...base,
		mode: "cdp",
		browser: windows.browser,
		profileDir: windows.profileDir,
		cdpUrl: windows.cdpUrl,
		winPid: windows.winPid,
	};
	return launchSeeded(spec, args.positionals[0], env, seed, deps, () =>
		deps.closeWindowsBrowser(windows.profileDir),
	);
}

function localTarget(
	args: ParsedArgs,
	deps: OpenDeps,
): Pick<LaunchSpec, "browser" | "executablePath"> {
	const explicit = stringFlag(args, "browser");
	if (explicit === undefined) {
		const pick = deps.pickLaunch();
		return "channel" in pick
			? { browser: pick.channel }
			: { browser: "chromium", executablePath: pick.executablePath };
	}
	const browser = parseBrowser(args);
	if (browser !== "chromium") return { browser };
	const executablePath = deps.downloadedChromium();
	if (!executablePath) throw new BrowserMissingError();
	return { browser, executablePath };
}

export async function runOpen(
	args: ParsedArgs,
	env: ClientEnv,
	deps: OpenDeps = DEFAULT_DEPS,
): Promise<number> {
	let headless = args.flags["headless"] === true;
	if (args.flags["windows"] === true)
		return openWindows(args, env, parseBrowser(args), deps);
	if (deps.isWSL()) {
		const plan = wslPlan(
			args.flags,
			args.flags["scratch"] !== true && deps.windowsBrowserPresent(),
		);
		if (plan.mode === "windows")
			return openWindows(args, env, parseBrowser(args), deps);
		if (plan.warning) env.err(plan.warning);
		headless = plan.headless;
	}
	const target = localTarget(args, deps);
	const seed = readSeed(args, env);

	const scratch = args.flags["scratch"] === true;
	const key = sessionKey({ name: args.session, scratch });
	const refused = await releaseKey(
		{ key, scratch },
		env,
		deps.closeWindowsBrowser,
	);
	if (refused !== null) return refused;

	const profileDir = scratch
		? null
		: path.resolve(
				env.cwd,
				stringFlag(args, "profile") ?? defaultProfileDir(args.session),
			);
	if (profileDir) ensurePrivateDir(profileDir);
	const spec: LaunchSpec = {
		...baseSpec(args, env, key, scratch),
		headless,
		mode: "local",
		profileDir,
		...target,
	};
	return launchSeeded(spec, args.positionals[0], env, seed, deps);
}

const open: ClientHandler = (args, env) => runOpen(args, env);

export default open;
