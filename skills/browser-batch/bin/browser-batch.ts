#!/usr/bin/env bun
/**
 * browser-batch — dispatch to a subcommand:
 *   open    resolve refs → open + group a batch of PRs/URLs (any default browser)
 *   install stage the dg-ai-extension extension + print guided load steps
 *   launch  cold-start a selectable Chromium browser with the extension side-loaded
 */

import { spawn } from "node:child_process";
import { runInstall } from "./install";
import { runLaunch } from "./launch";
import { isWSL } from "./lib";
import { addGroupMarker } from "./marker";
import { loadConfig, resolveRef } from "./refs";

const USAGE = `usage: browser-batch <command> [args]
  open    [--repo owner/repo] [--group <name>] [--print] <ref> ...  open + group a batch
  install [chrome|firefox] [--local]                               stage the extension + guided load
  launch  [--browser <key>] [--group <name>] [--list] <ref> ...    launch a Chromium browser w/ the extension

refs: full URL | owner/repo#num | alias#num | bare num (with --repo). Default group name: PRs`;

/** Ordered [command, argsBuilder] openers to try for this platform. */
function openers(): Array<[string, (url: string) => string[]]> {
	if (process.platform === "darwin") return [["open", (u) => [u]]];
	if (isWSL()) {
		return [
			["wslview", (u) => [u]],
			[
				"powershell.exe",
				(u) => ["-NoProfile", "-Command", `Start-Process '${u}'`],
			],
			["cmd.exe", (u) => ["/c", "start", "", u]],
		];
	}
	return [["xdg-open", (u) => [u]]];
}

function tryOpen(url: string): Promise<boolean> {
	const candidates = openers();
	return new Promise((resolve) => {
		const attempt = (i: number) => {
			if (i >= candidates.length) return resolve(false);
			const [cmd, build] = candidates[i];
			const child = spawn(cmd, build(url), { stdio: "ignore", detached: true });
			child.on("error", () => attempt(i + 1)); // opener missing — try next
			child.on("spawn", () => {
				child.unref();
				resolve(true);
			});
		};
		attempt(0);
	});
}

async function runOpen(argv: string[]): Promise<void> {
	const usage =
		"usage: browser-batch open [--repo owner/repo] [--group <name>] [--print] <url | owner/repo#num | alias#num | num> ...";
	const refs: string[] = [];
	let repo: string | undefined;
	let group = "PRs";
	let printOnly = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--repo" || a === "-R") repo = argv[++i];
		else if (a === "--group" || a === "-g") group = argv[++i];
		else if (a === "--print") printOnly = true;
		else if (a === "-h" || a === "--help") {
			console.log(usage);
			return;
		} else refs.push(a);
	}
	if (refs.length === 0) {
		console.error(usage);
		process.exit(1);
	}

	const cfg = loadConfig();
	let urls: string[];
	try {
		// Marker tells the extension to group these tabs into `group`, then strip it.
		urls = refs.map((r) => addGroupMarker(resolveRef(r, cfg, repo), group));
	} catch (err) {
		console.error(`browser-batch: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}

	if (printOnly) {
		for (const u of urls) console.log(u);
		return;
	}
	for (const url of urls) {
		const ok = await tryOpen(url);
		console.log(`${ok ? "opened" : "FAILED"}: ${url}`);
	}
	console.log(
		`\n${urls.length} tab(s) requested — dg-ai-extension will group them into "${group}".`,
	);
}

async function main(): Promise<void> {
	const [sub, ...rest] = process.argv.slice(2);
	switch (sub) {
		case "open":
			return runOpen(rest);
		case "install":
			return runInstall(rest);
		case "launch":
			return runLaunch(rest);
		case undefined:
		case "-h":
		case "--help":
			console.log(USAGE);
			return;
		default:
			console.error(`unknown command "${sub}"\n${USAGE}`);
			process.exit(1);
	}
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`browser-batch: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	});
}
