#!/usr/bin/env bun
/**
 * browser-batch — open a set of PRs (or arbitrary URLs) in the browser.
 *
 * The companion "dg-ai-browser-batch" extension does the actual grouping browser-side (by URL pattern), so this
 * CLI's only job is to resolve refs to URLs and open them. That keeps it working across the
 * WSL <-> Windows boundary, where a CLI can't talk to the browser directly.
 *
 * Accepted refs:
 *   - full URL:            https://github.com/owner/repo/pull/123
 *   - owner/repo#num:      owner/repo#1517
 *   - alias#num:           work#1517          (aliases come from your config below)
 *   - bare num:            1518               (uses --repo, or config.defaultRepo)
 *
 * Flags: --repo/-R owner/repo   override the default repo for bare numbers
 *        --print                 print resolved URLs instead of opening them
 *
 * Config (optional): ~/.config/browser-batch/config.json
 *   { "defaultRepo": "owner/repo",
 *     "aliases": { "work": "your-org/your-repo" } }
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Config = { defaultRepo?: string; aliases?: Record<string, string> };

// Define your own repo aliases in ~/.config/browser-batch/config.json.
const BUILTIN_ALIASES: Record<string, string> = {};

function loadConfig(): Config {
	try {
		return JSON.parse(readFileSync(join(homedir(), ".config", "browser-batch", "config.json"), "utf8"));
	} catch {
		return {};
	}
}

export function resolveRef(ref: string, cfg: Config, defaultRepo: string | undefined): string {
	if (/^https?:\/\//.test(ref)) return ref;

	const aliases = { ...BUILTIN_ALIASES, ...(cfg.aliases ?? {}) };

	const hashMatch = ref.match(/^(.+)#(\d+)$/);
	if (hashMatch) {
		const [, repoPart, num] = hashMatch;
		const repo = aliases[repoPart] ?? repoPart;
		return `https://github.com/${repo}/pull/${num}`;
	}

	if (/^\d+$/.test(ref)) {
		const repo = defaultRepo ?? cfg.defaultRepo;
		if (!repo) {
			throw new Error(`bare PR number "${ref}" needs a repo — pass --repo owner/repo or set defaultRepo in config`);
		}
		return `https://github.com/${aliases[repo] ?? repo}/pull/${ref}`;
	}

	throw new Error(`unrecognized ref: "${ref}" (use a URL, owner/repo#num, alias#num, or bare num with --repo)`);
}

function isWSL(): boolean {
	if (process.env.WSL_DISTRO_NAME) return true;
	try {
		return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
	} catch {
		return false;
	}
}

/** Ordered list of [command, argsBuilder] openers to try for this platform. */
function openers(): Array<[string, (url: string) => string[]]> {
	if (process.platform === "darwin") return [["open", (u) => [u]]];
	if (isWSL()) {
		return [
			["wslview", (u) => [u]],
			["powershell.exe", (u) => ["-NoProfile", "-Command", `Start-Process '${u}'`]],
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
			child.on("error", () => attempt(i + 1)); // opener not installed — try the next
			child.on("spawn", () => {
				child.unref();
				resolve(true);
			});
		};
		attempt(0);
	});
}

async function main() {
	const argv = process.argv.slice(2);
	const usage = "usage: browser-batch open [--repo owner/repo] [--print] <url | owner/repo#num | alias#num | num> ...";

	if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
		console.log(usage);
		return;
	}

	const subcommand = argv[0];
	if (subcommand !== "open") {
		console.error(usage);
		process.exit(1);
	}

	const refs: string[] = [];
	let repo: string | undefined;
	let printOnly = false;

	for (let i = 1; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--repo" || a === "-R") repo = argv[++i];
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
		urls = refs.map((r) => resolveRef(r, cfg, repo));
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
	console.log(`\n${urls.length} tab(s) requested — the dg-ai-browser-batch extension will group them.`);
}

if (import.meta.main) main();
