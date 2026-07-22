/**
 * `install` — ensure the dg-ai-extension is available to load, idempotently.
 *
 * Chrome/Edge/Brave forbid programmatically installing an unpacked extension, so
 * this stages the built extension to a stable per-OS path and prints guided
 * Load-unpacked steps. Assets come from the CI-built GitHub Release; in a source
 * checkout (dev) it falls back to a local `wxt build`. It also refreshes the
 * compiled dg-skills CLI binary (the release artifact the skills invoke).
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
import { join } from "node:path";
import type { Command } from "commander";
import {
	cliDest,
	cliVersionFile,
	downloadReleaseAsset,
	extensionDest,
	extractZip,
	fetchCliBinary,
	readMarker,
	repoRoot,
	resolveCliAsset,
	run,
	type Target,
	versionGte,
	writeMarkerEntry,
} from "../utils/lib";

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

function localOutputDir(target: Target): string | undefined {
	const outRoot = join(repoRoot(), "pkg", "extension", ".output");
	if (!existsSync(outRoot)) return undefined;
	const dir = readdirSync(outRoot).find((d) => d.startsWith(`${target}-`));
	return dir ? join(outRoot, dir) : undefined;
}

function buildLocally(target: Target): string {
	const src = join(repoRoot(), "pkg", "extension");
	if (!existsSync(src)) throw new Error("no pkg/extension to build from");
	if (!existsSync(join(src, "node_modules")))
		run("bun", ["--cwd", src, "install"]);
	run("bun", [
		"--cwd",
		src,
		"run",
		target === "firefox" ? "build:firefox" : "build",
	]);
	const out = localOutputDir(target);
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

/** Download/refresh the compiled dg-skills binary; best-effort (warn, never throw). */
async function installCli(): Promise<void> {
	try {
		const asset = await resolveCliAsset();
		if (!asset) {
			console.warn(
				`⚠ no dg-skills binary for ${process.platform}-${process.arch}; skipping CLI refresh.`,
			);
			return;
		}
		const vf = cliVersionFile();
		const installed = existsSync(vf) ? readFileSync(vf, "utf8").trim() : "";
		// The binary is large; skip the download when we're already current.
		if (
			installed &&
			existsSync(cliDest()) &&
			versionGte(installed, asset.version)
		) {
			console.log(`dg-skills CLI already current (v${installed}).`);
			return;
		}
		const path = await fetchCliBinary(asset);
		console.log(
			`dg-skills CLI ${installed ? "updated to" : "installed"} v${asset.version} at ${path}`,
		);
	} catch (err) {
		console.warn(
			`⚠ dg-skills CLI install skipped: ${err instanceof Error ? err.message : err}`,
		);
	}
}

async function install(target: Target, forceLocal: boolean): Promise<void> {
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
		const out = localOutputDir(target) ?? buildLocally(target);
		version = manifestVersion(out);
		stage = () => copyDir(out, dest.copyPath);
	}

	const markerVersion = readMarker()[target];
	if (
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
			"stage the dg-ai-extension for loading + refresh the compiled dg-skills CLI",
		)
		.argument(
			"[target]",
			"chrome (default; serves Brave/Edge/Vivaldi) | firefox",
		)
		.option("--local", "build from pkg/extension instead of the GitHub release")
		.action(async (target: string | undefined, opts: { local?: boolean }) => {
			await install(target === "firefox" ? "firefox" : "chrome", !!opts.local);
		});
}
