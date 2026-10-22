import path from "node:path";
import { stringFlag, UsageError } from "../../core/args";
import type { LaunchSpec } from "../../core/browser";
import { ensurePrivateDir } from "../../core/files";
import { launch, releaseKey, runRemote } from "../../core/launch";
import { defaultProfileDir } from "../../core/profiles";
import { BROWSERS, type BrowserName, defaultOutputDir, sessionKey, socketPathFor } from "../../core/registry";
import type { ClientEnv, ClientHandler, ParsedArgs } from "../../core/spec";
import { restoreState } from "../../core/state-restore";
import { importLegacyOnce, load, type StorageState, statePathFor, validateName } from "../../core/states";
import {
	assertSafeProfileDir,
	closeWindowsBrowser,
	isWindowsBrowser,
	isWindowsPath,
	startWindowsBrowser,
	WINDOWS_ONLY_MESSAGE,
	windowsProfileDir,
	wslToWindowsPath,
} from "../../core/windows";

export function parseSessionDepth(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!/^\d+$/.test(value)) throw new UsageError(`Invalid --depth '${value}': use a non-negative integer`);
	return Number(value);
}

function parseBrowser(args: ParsedArgs): BrowserName {
	const browser = stringFlag(args, "browser") ?? "chrome";
	const match = BROWSERS.find((known) => known === browser);
	if (!match) throw new UsageError(`Unsupported browser '${browser}': use ${BROWSERS.join(", ")}`);
	return match;
}

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
	onFailure?: () => Promise<unknown>,
): Promise<number> {
	if (!seed) return launch(spec, url, env, onFailure);
	if (spec.scratch) {
		return launch({ ...spec, storageState: statePathFor(seed.name) }, url, env, onFailure);
	}
	const opened = await launch(spec, undefined, env, onFailure);
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

function windowsProfileOverride(args: ParsedArgs, env: ClientEnv): string | undefined {
	const profile = stringFlag(args, "profile");
	if (!profile) return undefined;
	const windowsProfile = isWindowsPath(profile) ? profile : wslToWindowsPath(path.resolve(env.cwd, profile));
	assertSafeProfileDir(windowsProfile);
	return windowsProfile;
}

async function openWindows(args: ParsedArgs, env: ClientEnv, browser: BrowserName): Promise<number> {
	if (!isWindowsBrowser(browser)) throw new UsageError(WINDOWS_ONLY_MESSAGE);
	if (args.flags["scratch"] === true) throw new UsageError("--windows does not support --scratch");
	const profileOverride = windowsProfileOverride(args, env);
	const seed = readSeed(args, env);

	const key = sessionKey({ name: args.session, scratch: false });
	const refused = await releaseKey({ key, scratch: false }, env);
	if (refused !== null) return refused;

	let windows: Awaited<ReturnType<typeof startWindowsBrowser>>;
	try {
		const profileDir = profileOverride ?? (await windowsProfileDir(args.session));
		windows = await startWindowsBrowser({
			browser,
			profileDir,
			headless: args.flags["headless"] === true,
		});
	} catch (error) {
		env.err(`### Error\n${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}

	const spec: LaunchSpec = {
		...baseSpec(args, env, key, false),
		mode: "cdp",
		browser: windows.browser,
		profileDir: windows.profileDir,
		cdpUrl: windows.cdpUrl,
		winPid: windows.winPid,
	};
	return launchSeeded(spec, args.positionals[0], env, seed, () => closeWindowsBrowser(windows.profileDir));
}

const open: ClientHandler = async (args, env) => {
	const browser = parseBrowser(args);
	if (args.flags["windows"] === true) return openWindows(args, env, browser);
	const seed = readSeed(args, env);

	const scratch = args.flags["scratch"] === true;
	const key = sessionKey({ name: args.session, scratch });
	const refused = await releaseKey({ key, scratch }, env);
	if (refused !== null) return refused;

	const profileDir = scratch
		? null
		: path.resolve(env.cwd, stringFlag(args, "profile") ?? defaultProfileDir(args.session));
	if (profileDir) ensurePrivateDir(profileDir);
	const spec: LaunchSpec = { ...baseSpec(args, env, key, scratch), mode: "local", browser, profileDir };
	return launchSeeded(spec, args.positionals[0], env, seed);
};

export default open;
