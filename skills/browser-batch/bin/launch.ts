#!/usr/bin/env bun
/**
 * launch — start a selectable Chromium browser with the dg-ai-extension
 * extension side-loaded (`--load-extension`) plus a batch of tabs, so PRs open
 * grouped without a manual chrome://extensions step.
 *
 * The flag only applies on a cold start of the profile, so the target browser
 * must be fully closed first. Chrome stable disabled the flag — use Brave/Edge.
 * Firefox isn't supported here (different load model); use `install firefox`.
 */

import { spawn } from "node:child_process";
import { type DetectedBrowser, detectBrowsers } from "./detect";
import { extensionDest, isWSL, readMarker, run } from "./lib";
import { resolveRefs } from "./refs";

const USAGE = "usage: browser-batch launch [--browser <key>] [--list] [--dry-run] [--repo owner/repo] <ref> ...";

function table(browsers: DetectedBrowser[]): string {
	return browsers
		.map((b) => {
			const note = b.launchable
				? "✓ launchable"
				: b.kind === "chrome-stable"
					? "✗ --load-extension disabled on Chrome stable"
					: b.kind === "firefox"
						? "✗ use `install firefox`"
						: "✗ unsupported";
			return `  ${b.key.padEnd(16)} ${b.name} ${b.version}  [${note}]`;
		})
		.join("\n");
}

function isRunning(exe: string): boolean {
	// Match the exact exe path so Brave Beta vs Origin (same brave.exe) are distinct.
	const escaped = exe.replace(/'/g, "''");
	try {
		const out = run("powershell.exe", [
			"-NoProfile",
			"-Command",
			`if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${escaped}' }) { 'RUNNING' }`,
		]);
		return out.includes("RUNNING");
	} catch {
		return false; // can't tell — let the launch proceed
	}
}

export async function runLaunch(argv: string[]): Promise<void> {
	let browserKey: string | undefined;
	let repo: string | undefined;
	let listOnly = false;
	let dryRun = false;
	const refs: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--browser" || a === "-b") browserKey = argv[++i];
		else if (a === "--repo" || a === "-R") repo = argv[++i];
		else if (a === "--list") listOnly = true;
		else if (a === "--dry-run") dryRun = true;
		else if (a === "-h" || a === "--help") {
			console.log(USAGE);
			return;
		} else refs.push(a);
	}

	const browsers = detectBrowsers();
	if (!browsers.length) {
		console.error("browser-batch launch: no browsers detected (launch supports Windows/WSL for now).");
		process.exit(1);
	}
	if (listOnly) {
		console.log(`Detected browsers:\n${table(browsers)}`);
		return;
	}

	const wantKey = browserKey?.toLowerCase();
	const chosen = wantKey
		? browsers.find((b) => b.key === wantKey || b.name.toLowerCase().includes(wantKey))
		: browsers.find((b) => b.launchable);
	if (!chosen) {
		console.error(`browser-batch launch: no match for --browser "${browserKey}". Available:\n${table(browsers)}`);
		process.exit(1);
	}
	if (chosen.kind === "chrome-stable") {
		console.error(
			`${chosen.name} disabled --load-extension on the stable channel, so it can't be scripted.\n` +
				"Pick a Chromium browser like Brave or Edge (see `launch --list`), or run\n" +
				"`browser-batch install` and load unpacked into Chrome manually once.",
		);
		process.exit(1);
	}
	if (chosen.kind !== "chromium") {
		console.error(
			`${chosen.name} isn't supported by launch (Chromium only). For Firefox, run\n` +
				"`browser-batch install firefox` and load it as a temporary add-on.",
		);
		process.exit(1);
	}

	if (!readMarker().chrome) {
		console.error("Extension not staged yet — run `browser-batch install` first, then `launch`.");
		process.exit(1);
	}
	if (!refs.length) {
		console.error(USAGE);
		process.exit(1);
	}

	let urls: string[];
	try {
		urls = resolveRefs(refs, repo);
	} catch (err) {
		console.error(`browser-batch launch: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}

	if (isRunning(chosen.exe)) {
		console.error(
			`${chosen.name} is running. Fully close it first (the --load-extension flag only\n` +
				"applies on a cold start), then re-run this command.",
		);
		process.exit(1);
	}

	const dest = extensionDest("chrome"); // Chromium browsers load the chrome build
	const exeToSpawn = isWSL() ? run("wslpath", ["-u", chosen.exe]) : chosen.exe;
	const args = [`--load-extension=${dest.printPath}`, ...urls];

	if (dryRun) {
		console.log(`[dry-run] ${exeToSpawn} ${args.join(" ")}`);
		return;
	}

	const child = spawn(exeToSpawn, args, { stdio: "ignore", detached: true });
	child.on("error", (e) => {
		console.error(`failed to launch ${chosen.name}: ${e.message}`);
		process.exit(1);
	});
	child.unref();
	console.log(`Launched ${chosen.name} with dg-ai-extension + ${urls.length} tab(s) — they'll group as they load.`);
}

if (import.meta.main) {
	runLaunch(process.argv.slice(2)).catch((err) => {
		console.error(`browser-batch launch failed: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
