/**
 * `install` — ensure the dg-ai-extension is available to load, idempotently.
 *
 * Chrome/Edge/Brave forbid programmatically installing an unpacked extension, so
 * this stages the built extension to a stable per-OS path and prints guided
 * Load-unpacked steps. Assets come from the CI-built GitHub Release; in a source
 * checkout (dev) it falls back to a local `wxt build`. It also installs the compiled dg program
 * and points the dg launcher at it.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { skillDirectoryNames } from "@dg/common";
import { assertSkillsDestMoved, isDaemonLive, moveVerified, personasDest, readPidFile, removeSource, resolveDgPaths, run, skillsInstallDest, withInstallLock } from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";
import { writeCompletions } from "../completion/files";
import { PROGRAM_NAMES } from "@dg/common/node/program";
import { installCompiled, versionProgramPath } from "./compiled";
import { linkCurrent } from "./current";
import { refreshPhoneListener } from "./phone-listener";
import { finishLauncherLayout, migrateBeforeInstall } from "./layout";
import {
	assertSkillsOnlyFlags,
	runSkillsOnlyInstall,
	skillsOnlyReport,
} from "./skills-only";
import {
	cliBinDir,
	dgDir,
	downloadReleaseAsset,
	extensionDest,
	extensionDgDirs,
	legacyExtensionDest,
	extractZip,
	installRoot,
	listReleases,
	type PickedProgram,
	pickProgram,
	type Release,
	readCurrentVersion,
	readMarker,
	repoRoot,
	type Target,
	versionGte,
	writeMarkerEntry,
} from "../utils/lib";
import { removeLegacyExtensions, syncDirInPlace } from "../utils/extension-files";
import { installPackagedPersonas } from "../proxy/packaged-personas";
import { setCliOnly } from "../utils/cli-only";
import { prunePluginCache } from "../install/prune-plugin-cache";
import {
	bundleChangedTo,
	installRecommendedForClaude,
	recommendedPlugins,
	runSync,
} from "./recommended-plugins";
import { installRecommendedSkillsOnly } from "./recommended-skills-only";

function reloadFromNewFolder(target: Target, path: string): string {
	return target === "firefox"
		? `dg: the dg-ai-extension (firefox) folder moved to ${path}. Open about:debugging#/runtime/this-firefox and load ${join(path, "manifest.json")} once.`
		: `dg: the dg-ai-extension (${target}) folder moved to ${path}. Open chrome://extensions once, remove the old dg-ai-extension entry, then click Load unpacked and select ${path}.`;
}

/** Moves the extension staged by an older release into the data root; true when the browser must load it again. */
function moveStagedExtension(target: Target, dest: { copyPath: string; printPath: string }): boolean {
	const old = legacyExtensionDest(target);
	if (old.copyPath === dest.copyPath || !existsSync(old.copyPath)) return false;
	if (existsSync(dest.copyPath)) removeSource(old.copyPath);
	else if (moveVerified(old.copyPath, dest.copyPath, { log: console.log }) === "failed") return false;
	console.log(reloadFromNewFolder(target, dest.printPath));
	return true;
}

function retireLegacyExtensions(): void {
	if (removeLegacyExtensions(extensionDgDirs()).length === 0) return;
	console.log(
		'Removed the retired "dg-ai-browser-batch" extension folders. If "dg-ai-browser-batch" is still listed at chrome://extensions, remove it there.',
	);
}

const hasExtensionSource = (root: string): boolean =>
	existsSync(join(root, "pkg", "extension", "package.json"));

function findUpward(dir: string): string | undefined {
	if (hasExtensionSource(dir)) return dir;
	const parent = dirname(dir);
	return parent === dir ? undefined : findUpward(parent);
}

export function resolveLocalRepo(
	repo: string | undefined,
	cwd: string,
	fallback: string = repoRoot(),
): string {
	const found = repo
		? [resolve(repo)].find(hasExtensionSource)
		: (findUpward(cwd) ?? [fallback].find(hasExtensionSource));
	if (!found) {
		throw new Error(
			"no pkg/extension to build from: run this from inside the dg repo or pass --repo <path>",
		);
	}
	return found;
}

function localOutputDir(root: string, target: Target): string | undefined {
	const outRoot = join(root, "pkg", "extension", ".output");
	if (!existsSync(outRoot)) return undefined;
	const dir = readdirSync(outRoot).find((d) => d.startsWith(`${target}-`));
	return dir ? join(outRoot, dir) : undefined;
}

export function localBuildScripts(
	target: Target,
	dependenciesInstalled: boolean,
): string[][] {
	return [
		...(dependenciesInstalled ? [] : [["install"]]),
		["run", target === "firefox" ? "build:firefox" : "build"],
	];
}

function buildLocally(root: string, target: Target): string {
	const src = join(root, "pkg", "extension");
	const wxtBin = join(root, "node_modules", ".bin", "wxt");
	localBuildScripts(target, existsSync(wxtBin)).forEach((args) => {
		run("bun", args, { cwd: src });
	});
	const out = localOutputDir(root, target);
	if (!out) throw new Error("local build produced no output directory");
	return out;
}

function manifestVersion(dir: string): string {
	return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).version;
}

function printSteps(target: Target, path: string): void {
	if (target === "firefox") {
		console.log(
			"Firefox (temporary add-on — reloads each session; use `dg pw --ext launch` to automate):",
		);
		console.log("  1. Open about:debugging#/runtime/this-firefox");
		console.log('  2. Click "Load Temporary Add-on…"');
		console.log(`  3. Select ${join(path, "manifest.json")}`);
		return;
	}
	console.log(
		"1. Open chrome://extensions (or your Chromium browser's extensions page).",
	);
	console.log('2. Enable "Developer mode".');
	console.log('3. Click "Load unpacked".');
	console.log(`4. Select ${path}`);
	console.log("5. Done.");
}

/** "already current" on a later install; "verified" for the binary bootstrap just wrote. */
export function currentBinaryLine(
	binaryName: string,
	version: string,
	bootstrapped = process.env.DG_SKILLS_BOOTSTRAP === "1",
): string {
	if (bootstrapped && binaryName === "dg") {
		return `${binaryName} verified (v${version}).`;
	}
	return `${binaryName} already current (v${version}).`;
}

const RETIRED_BINARIES = ["dg-server"];

export function removeRetiredBinaries(): void {
	for (const bin of new Set([cliBinDir(), join(dgDir(), "bin")])) {
		for (const name of RETIRED_BINARIES) {
			for (const dest of [join(bin, name), join(bin, `${name}.exe`)]) {
				if (!existsSync(dest)) continue;
				rmSync(dest, { force: true });
				console.log(`removed the retired ${name} binary at ${dest}.`);
			}
		}
		for (const name of [...RETIRED_BINARIES, ...PROGRAM_NAMES]) {
			rmSync(join(bin, `.${name}.version`), { force: true });
		}
	}
}

function installCompletions(): void {
	try {
		writeCompletions();
	} catch (err) {
		console.warn(`⚠ shell completion skipped: ${err instanceof Error ? err.message : err}`);
	}
}

/** Installs the compiled dg of one release, then points the dg launcher at it. */
async function installProgram(release: PickedProgram): Promise<void> {
	const root = installRoot();
	const paths = resolveDgPaths();
	assertNotBlocked(paths, "lib");
	await withInstallLock(root, () => installProgramLocked(root, release));
}

/** Installs the compiled dg of one release, and nothing else. */
export async function installProgramOnly(version: string): Promise<void> {
	await installProgram(pickProgram(await listReleases(), version));
}

async function installProgramLocked(root: string, release: PickedProgram, bridge = false): Promise<void> {
	const installed = readCurrentVersion(root);
	const present = existsSync(versionProgramPath(root, release.version));
	const final = await installCompiled(root, release);
	await finishLauncherLayout(release.version, { bridge });
	installCompletions();
	removeRetiredBinaries();
	console.log(
		present && installed === release.version
			? currentBinaryLine("dg", release.version)
			: `dg ${installed ? "updated to" : "installed"} v${release.version} at ${final}`,
	);
}

/**
 * The hidden `install launchers` step. A 6.3 self-update runs it from the new bundle: it installs the compiled
 * dg of this build, then points the dg launcher at it and removes the old launchers.
 */
export async function writeCurrentLaunchers(): Promise<void> {
	const version = process.env.DG_BUILD_VERSION ?? readCurrentVersion();
	if (!version || version === "dev") throw new Error("no dg release is installed; run dg install");
	const root = installRoot();
	if (existsSync(versionProgramPath(root, version))) {
		await withInstallLock(root, () => {
			linkCurrent(root, "bin", version);
			return finishLauncherLayout(version, { bridge: true });
		});
	} else {
		const release = pickProgram(await listReleases(), version);
		await withInstallLock(root, () => installProgramLocked(root, release, true));
	}
	refreshPhoneListener();
	const handle = readPidFile(resolveDgPaths());
	if (handle && (await isDaemonLive(handle))) console.log("dg: run dg daemon restart so the running daemon moves to the compiled dg");
}

/** An unpinned install keeps the old warn-and-continue behavior when the dg program cannot be installed. */
async function installNewestProgram(releases: Release[]): Promise<void> {
	try {
		await installProgram(pickProgram(releases));
	} catch (err) {
		console.warn(`⚠ dg install skipped: ${err instanceof Error ? err.message : err}`);
	}
}

function pruneClaudePluginCache(keep: boolean): void {
	prunePluginCache({ home: homedir(), now: Date.now(), keep, log: console.log });
}

function noteForeignDgHome(): void {
	const home = process.env.DG_HOME;
	if (home) console.error(`note: DG_HOME=${home}; installing there`);
}

async function installCli(keepCache: boolean): Promise<void> {
	await installNewestProgram(await listReleases());
	refreshPhoneListener();
	pruneClaudePluginCache(keepCache);
}

/** Skills-only installs fetch the compiled dg so the skills can run it; never the extension. */
async function installSkillsCli(version?: string, releases?: Release[]): Promise<void> {
	let resolved: Release[];
	if (releases) {
		resolved = releases;
	} else {
		try {
			resolved = await listReleases();
		} catch (err) {
			console.warn(`⚠ dg install skipped: ${err instanceof Error ? err.message : err}`);
			return;
		}
	}
	if (version) await installProgram(pickProgram(resolved, version));
	else await installNewestProgram(resolved);
}

async function installCliOnly(keepCache: boolean, version?: string): Promise<void> {
	const releases = await listReleases();
	if (version) await installProgram(pickProgram(releases, version));
	else await installNewestProgram(releases);
	assertSkillsDestMoved(process.env, homedir());
	const skillsDest = skillsInstallDest(process.env, homedir());
	const personas = installPackagedPersonas(skillsDest);
	setCliOnly(true);
	console.log(
		`Installed ${personas.length} personas at ${personasDest(skillsDest)}.`,
	);
	console.log(
		'CLI-only install: the extension was skipped. Run "dg install" to add it.',
	);
	pruneClaudePluginCache(keepCache);
}

/** For a non-Claude agent that only needs phone: the compiled dg, no extension. */
async function installAgentOnly(keepCache: boolean, version?: string): Promise<void> {
	const releases = await listReleases();
	if (version) await installProgram(pickProgram(releases, version));
	else await installNewestProgram(releases);
	setCliOnly(true);
	console.log(
		'Agent-only install: the extension was skipped. Run "dg install" to add it.',
	);
	refreshPhoneListener();
	pruneClaudePluginCache(keepCache);
}

/** Runs `stage`, then the staged/upgrade/first-install messaging and marker write shared by every install path. */
function finishExtensionStage(
	target: Target,
	dest: { copyPath: string; printPath: string },
	version: string,
	markerVersion: string | undefined,
	stage: () => void,
	moved = false,
): void {
	stage();
	console.log(`dg-ai-extension (${target}) staged at ${dest.printPath}`);
	if (markerVersion && !moved) {
		console.log("extension updated — click the reload icon on the extensions page.");
	} else if (!moved) {
		printSteps(target, dest.printPath);
	}

	writeMarkerEntry(target, version);
	console.log(`dg-ai-extension (${target}) set up (v${version}).`);
}

/** A pinned default install: resolves the dg program and the extension before changing anything. */
async function installPinnedAll(target: Target, pin: string, keepCache: boolean): Promise<void> {
	const dest = extensionDest(target);
	const releases = await listReleases();

	const program = pickProgram(releases, pin);
	const release = await downloadReleaseAsset(target, pin);
	await installProgram(program);

	retireLegacyExtensions();
	const moved = moveStagedExtension(target, dest);
	const markerVersion = readMarker()[target];
	if (markerVersion === release.version && existsSync(dest.copyPath)) {
		console.log(`dg-ai-extension (${target}) already set up (v${markerVersion}).`);
	} else {
		finishExtensionStage(
			target,
			dest,
			release.version,
			markerVersion,
			() => extractZip(release.zip, dest.copyPath),
			moved,
		);
	}

	setCliOnly(false);
	refreshPhoneListener();
	pruneClaudePluginCache(keepCache);
}

async function install(
	target: Target,
	forceLocal: boolean,
	repo: string | undefined,
	pin: string | undefined,
	keepCache: boolean,
): Promise<void> {
	if (!forceLocal && pin) {
		await installPinnedAll(target, pin, keepCache);
		return;
	}
	const dest = extensionDest(target);

	// Resolve a source + version: CI release first, local build as dev fallback.
	let version: string;
	let stage: () => void;
	const release = forceLocal
		? undefined
		: await downloadReleaseAsset(target).catch((err) => {
				console.warn(
					`⚠ release download unavailable (${err instanceof Error ? err.message : err}); trying local build…`,
				);
				return undefined;
			});

	if (release) {
		version = release.version;
		stage = () => extractZip(release.zip, dest.copyPath);
	} else {
		const root = resolveLocalRepo(repo, process.cwd());
		const out = forceLocal
			? buildLocally(root, target)
			: (localOutputDir(root, target) ?? buildLocally(root, target));
		version = manifestVersion(out);
		stage = () => syncDirInPlace(out, dest.copyPath);
	}

	retireLegacyExtensions();
	const moved = moveStagedExtension(target, dest);
	const markerVersion = readMarker()[target];
	if (!forceLocal && markerVersion && versionGte(markerVersion, version) && existsSync(dest.copyPath)) {
		console.log(
			`dg-ai-extension (${target}) already set up (v${markerVersion}).`,
		);
		if (!forceLocal) await installCli(keepCache);
		setCliOnly(false);
		return;
	}

	finishExtensionStage(target, dest, version, markerVersion, stage, moved);

	// Also keep the dg program current (skip in --local dev, where we run source).
	if (!forceLocal) await installCli(keepCache);
	setCliOnly(false);
}

function withCurrentPins(step: () => void): void {
	const moved = bundleChangedTo(process.env.DG_BUILD_VERSION ?? "dev", readCurrentVersion());
	if (!moved) return step();
	console.log(
		`⚠ recommended plugins skipped: dg is now v${moved}. Run the same dg install command again to install them at its pins.`,
	);
}

export type InstallOptions = {
	local?: boolean;
	repo?: string;
	cliOnly?: boolean;
	agentOnly?: boolean;
	skillsOnly?: boolean;
	dest?: string;
	version?: string;
	keepCache?: boolean;
	withRecommended?: boolean;
};

export async function runInstall(
	target: string | undefined,
	opts: InstallOptions,
): Promise<void> {
	if (opts.withRecommended && opts.agentOnly) {
		throw new Error("--with-recommended cannot be combined with --agent-only");
	}
	await migrateBeforeInstall();
	noteForeignDgHome();
	if (opts.skillsOnly) {
		assertSkillsOnlyFlags({
			cliOnly: !!opts.cliOnly,
			agentOnly: !!opts.agentOnly,
			local: !!opts.local,
			target,
		});
		let releases: Release[] | undefined;
		if (opts.version) {
			releases = await listReleases();
			pickProgram(releases, opts.version);
		}
		const result = runSkillsOnlyInstall({
			repo: opts.repo,
			dest: opts.dest,
			repoRoot: repoRoot(),
		});
		console.log(skillsOnlyReport(result));
		await installSkillsCli(opts.version, releases);
		if (opts.withRecommended) {
			const dgNames = new Set(skillDirectoryNames(result.files));
			withCurrentPins(() => {
				for (const plugin of recommendedPlugins()) {
					installRecommendedSkillsOnly(plugin, result.dest, dgNames, console.log);
				}
			});
		}
		return;
	}
	if (opts.cliOnly && opts.agentOnly) {
		throw new Error("install accepts only one of --cli-only and --agent-only");
	}
	if (opts.agentOnly) {
		await installAgentOnly(!!opts.keepCache || !!opts.local, opts.version);
		return;
	}
	if (opts.cliOnly) {
		await installCliOnly(!!opts.keepCache || !!opts.local, opts.version);
	} else {
		await install(
			target === "firefox" ? "firefox" : "chrome",
			!!opts.local,
			opts.repo,
			opts.version,
			!!opts.keepCache,
		);
	}
	if (opts.withRecommended) {
		withCurrentPins(() => installRecommendedForClaude(recommendedPlugins(), homedir(), runSync, console.log));
	}
}
