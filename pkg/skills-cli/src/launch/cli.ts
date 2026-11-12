/**
 * `launch` — start a selectable Chromium browser with the dg-ai-extension
 * side-loaded (`--load-extension`) plus a batch of tabs, so PRs open grouped
 * without a manual chrome://extensions step.
 *
 * The flag only applies on a cold start of the profile, so the target browser
 * must be fully closed first. Chrome stable disabled the flag — use Brave/Edge.
 * Firefox isn't supported here (different load model); use `install firefox`.
 */

import { spawn } from "node:child_process";
import { newBatchId } from "@dg/common";
import { isWSL, run } from "@dg/common/node";
import { type DetectedBrowser, detectBrowsers } from "../utils/detect";
import { extensionDest, readMarker } from "../utils/lib";
import { addGroupMarker } from "../utils/marker";
import { resolveRefs } from "../utils/refs";

export type LaunchOptions = {
	browser?: string;
	repo?: string;
	group: string;
	list?: boolean;
	dryRun?: boolean;
	ext?: boolean;
};

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

export async function runLaunch(refs: string[], opts: LaunchOptions): Promise<number> {
	if (!opts.ext) {
		console.error(
			"launch: an extension-only command; add --ext (dg-skills launch --ext ...)",
		);
		return 1;
	}
	const browsers = detectBrowsers();
	if (!browsers.length) {
		console.error(
			"launch: no browsers detected (launch supports Windows/WSL for now).",
		);
		return 1;
	}
	if (opts.list) {
		console.log(`Detected browsers:\n${table(browsers)}`);
		return 0;
	}

	const wantKey = opts.browser?.toLowerCase();
	const chosen = wantKey
		? browsers.find(
				(b) => b.key === wantKey || b.name.toLowerCase().includes(wantKey),
			)
		: browsers.find((b) => b.launchable);
	if (!chosen) {
		console.error(
			`launch: no match for --browser "${opts.browser}". Available:\n${table(browsers)}`,
		);
		return 1;
	}
	if (chosen.kind === "chrome-stable") {
		console.error(
			`${chosen.name} disabled --load-extension on the stable channel, so it can't be scripted.\n` +
				"Pick a Chromium browser like Brave or Edge (see `launch --list`), or run\n" +
				"`install` and load unpacked into Chrome manually once.",
		);
		return 1;
	}
	if (chosen.kind !== "chromium") {
		console.error(
			`${chosen.name} isn't supported by launch (Chromium only). For Firefox, run\n` +
				"`install firefox` and load it as a temporary add-on.",
		);
		return 1;
	}

	if (!readMarker().chrome) {
		console.error(
			"Extension not staged yet — run `install` first, then `launch`.",
		);
		return 1;
	}
	if (!refs.length) {
		console.error("launch: at least one ref is required (or use --list).");
		return 1;
	}

	const batch = newBatchId();
	const urls = resolveRefs(refs, opts.repo).map((u) =>
		addGroupMarker(u, opts.group, undefined, batch),
	);

	if (isRunning(chosen.exe)) {
		console.error(
			`${chosen.name} is running. Fully close it first (the --load-extension flag only\n` +
				"applies on a cold start), then re-run this command.",
		);
		return 1;
	}

	const dest = extensionDest("chrome"); // Chromium browsers load the chrome build
	const exeToSpawn = isWSL() ? run("wslpath", ["-u", chosen.exe]) : chosen.exe;
	const args = [`--load-extension=${dest.printPath}`, ...urls];

	if (opts.dryRun) {
		console.log(`[dry-run] ${exeToSpawn} ${args.join(" ")}`);
		return 0;
	}

	const child = spawn(exeToSpawn, args, { stdio: "ignore", detached: true });
	const spawnError = await new Promise<Error | undefined>((resolve) => {
		child.once("spawn", () => resolve(undefined));
		child.once("error", resolve);
	});
	if (spawnError) {
		console.error(`failed to launch ${chosen.name}: ${spawnError.message}`);
		return 1;
	}
	child.unref();
	console.log(
		`Launched ${chosen.name} with dg-ai-extension + ${urls.length} tab(s) — grouping into "${opts.group}" as they load.`,
	);
	return 0;
}
