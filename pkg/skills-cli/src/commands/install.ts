/**
 * `install` — ensure the dg-ai-extension is available to load, idempotently.
 *
 * Chrome/Edge/Brave forbid programmatically installing an unpacked extension, so
 * this stages the built extension to a stable per-OS path and prints guided
 * Load-unpacked steps. Assets come from the CI-built GitHub Release; in a source
 * checkout (dev) it falls back to a local `wxt build`. It also refreshes the
 * compiled dg-skills and dg-daemon binaries (the release artifacts skills invoke).
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run } from "@dg/common/node";
import {
	assertSkillsOnlyFlags,
	runSkillsOnlyInstall,
	skillsOnlyReport,
} from "./skills-only";
import type { Command } from "commander";
import {
	type BinarySpec,
	cliDest,
	cliVersionFile,
	describeMissingCliAsset,
	downloadReleaseAsset,
	extensionDest,
	extractZip,
	fetchCliBinary,
	listReleases,
	type Release,
	readMarker,
	repoRoot,
	resolveCliAsset,
	type Target,
	versionGte,
	writeMarkerEntry,
} from "../utils/lib";
import { setCliOnly } from "../utils/cli-only";

function copyDir(src: string, dest: string): void {
	rmSync(dest, { recursive: true, force: true });
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src)) {
		const from = join(src, entry);
		const to = join(dest, entry);
		if (statSync(from).isDirectory()) copyDir(from, to);
		else copyFileSync(from, to);
	}
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
			"Firefox (temporary add-on — reloads each session; use `launch` to automate):",
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
	if (bootstrapped && binaryName === "dg-skills") {
		return `${binaryName} verified (v${version}).`;
	}
	return `${binaryName} already current (v${version}).`;
}

async function installBinary(
	spec: BinarySpec,
	releases: Release[],
): Promise<void> {
	const { binaryName } = spec;
	try {
		const asset = resolveCliAsset(spec, releases);
		if (!asset) {
			const reason = describeMissingCliAsset(spec, releases);
			const platform = `${process.platform}-${process.arch}`;
			console.warn(
				reason.kind === "no-platform-asset"
					? `⚠ ${binaryName}: this platform (${platform}) has no published asset; skipping its refresh.`
					: `⚠ ${binaryName}: no release with tag prefix "${spec.tagPrefix}" was found in the ${reason.releasesScanned} releases scanned; skipping its refresh.`,
			);
			return;
		}
		const vf = cliVersionFile(binaryName);
		const installed = existsSync(vf) ? readFileSync(vf, "utf8").trim() : "";
		// The binary is large; skip the download when we're already current.
		if (
			installed &&
			existsSync(cliDest(binaryName)) &&
			versionGte(installed, asset.version)
		) {
			console.log(currentBinaryLine(binaryName, installed));
			return;
		}
		const path = await fetchCliBinary(binaryName, asset);
		console.log(
			`${binaryName} ${installed ? "updated to" : "installed"} v${asset.version} at ${path}`,
		);
	} catch (err) {
		console.warn(
			`⚠ ${binaryName} install skipped: ${err instanceof Error ? err.message : err}`,
		);
	}
}

const RETIRED_BINARIES = ["dg-server"];

export function removeRetiredBinaries(): void {
	for (const name of RETIRED_BINARIES) {
		const dest = cliDest(name);
		if (!existsSync(dest)) continue;
		rmSync(dest, { force: true });
		rmSync(cliVersionFile(name), { force: true });
		console.log(`removed the retired ${name} binary at ${dest}.`);
	}
}

const BINARIES: BinarySpec[] = [
	{ binaryName: "dg-skills", tagPrefix: "skills-v" },
	{ binaryName: "dg-daemon", tagPrefix: "daemon-v" },
	{ binaryName: "dg-agent", tagPrefix: "agent-v" },
];

async function installCli(): Promise<void> {
	const releases = await listReleases();
	for (const spec of BINARIES) {
		await installBinary(spec, releases);
	}
	removeRetiredBinaries();
}

/** Skills-only installs fetch the dg-skills CLI so the skills can run it; never the daemon, agent or extension. */
async function installSkillsCli(): Promise<void> {
	let releases: Release[];
	try {
		releases = await listReleases();
	} catch (err) {
		// Same warn-and-continue as installBinary: the skills are already copied.
		console.warn(`⚠ dg-skills install skipped: ${err instanceof Error ? err.message : err}`);
		return;
	}
	await installBinary(BINARIES[0], releases);
}

async function installCliOnly(): Promise<void> {
	const releases = await listReleases();
	await installBinary(BINARIES[0], releases);
	setCliOnly(true);
	console.log(
		'CLI-only install: the extension, dg-daemon and dg-agent were skipped. Run "dg-skills install" to add them.',
	);
}

async function install(
	target: Target,
	forceLocal: boolean,
	repo?: string,
): Promise<void> {
	setCliOnly(false);
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
		stage = () => copyDir(out, dest.copyPath);
	}

	const markerVersion = readMarker()[target];
	if (
		!forceLocal &&
		markerVersion &&
		versionGte(markerVersion, version) &&
		existsSync(dest.copyPath)
	) {
		console.log(
			`dg-ai-extension (${target}) already set up (v${markerVersion}).`,
		);
		if (!forceLocal) await installCli();
		return;
	}
	const isUpgrade = Boolean(markerVersion);

	stage();
	console.log(`dg-ai-extension (${target}) staged at ${dest.printPath}`);
	if (isUpgrade) {
		console.log(
			"extension updated — click the reload icon on the extensions page.",
		);
	} else {
		printSteps(target, dest.printPath);
	}
	writeMarkerEntry(target, version);
	console.log(`dg-ai-extension (${target}) set up (v${version}).`);

	// Also keep the compiled CLI current (skip in --local dev, where we run source).
	if (!forceLocal) await installCli();
}

export function registerInstall(program: Command): void {
	program
		.command("install")
		.description(
			"stage the dg-ai-extension for loading + refresh the compiled dg-skills, dg-daemon and dg-agent binaries, or copy skill instruction files with --skills-only",
		)
		.argument(
			"[target]",
			"chrome (default; serves Brave/Edge/Vivaldi) | firefox",
		)
		.option("--local", "build from pkg/extension instead of the GitHub release")
		.option("--repo <path>", "dg repo to build from (default: search up from cwd)")
		.option(
			"--cli-only",
			"install only the dg-skills binary; skip the extension, dg-daemon and dg-agent",
		)
		.option(
			"--skills-only",
			"copy plugins/dg/skills instruction files only; fetch no binaries and run no skill content",
		)
		.option(
			"--dest <path>",
			"directory for --skills-only (default: $DG_SKILLS_DEST, else $DG_HOME/skills or ~/.dg/skills)",
		)
		.action(
			async (
				target: string | undefined,
				opts: {
					local?: boolean;
					repo?: string;
					cliOnly?: boolean;
					skillsOnly?: boolean;
					dest?: string;
				},
			) => {
				if (opts.skillsOnly) {
					assertSkillsOnlyFlags({
						cliOnly: !!opts.cliOnly,
						local: !!opts.local,
						target,
					});
					const result = runSkillsOnlyInstall({
						repo: opts.repo,
						dest: opts.dest,
						repoRoot: repoRoot(),
					});
					console.log(skillsOnlyReport(result));
					await installSkillsCli();
					return;
				}
				if (opts.cliOnly) return installCliOnly();
				await install(
					target === "firefox" ? "firefox" : "chrome",
					!!opts.local,
					opts.repo,
				);
			},
		);
}
