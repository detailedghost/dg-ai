import { existsSync, readdirSync } from "node:fs";
import { cwdHash, projectHash, scratchRoot, stateRoot } from "@dg/common/node";
import { slugify } from "../worktree/core";
import {
	die,
	flagValue,
	isDirectory,
	PROGRAM,
	say,
	usageError,
} from "./shared";

export function slugOrDie(input: string): string {
	const slug = slugify(input);
	if (slug === "") die("slug is empty after normalization");
	return slug;
}

export function slugifyCommand(args: string[]): number {
	if (args.length < 1) usageError("slugify <input>");
	say(`${slugOrDie(args.join(" "))}\n`);
	return 0;
}

function formatNnn(max: number): string {
	return String(max + 1).padStart(3, "0");
}

export function nextBundleNnn(root: string): string {
	if (!isDirectory(root)) return "001";
	let max = 0;
	for (const name of readdirSync(root)) {
		if (!/^\d{3}_/.test(name) || !isDirectory(`${root}/${name}`)) continue;
		max = Math.max(max, Number.parseInt(name.slice(0, 3), 10));
	}
	return formatNnn(max);
}

export function nextNnnCommand(args: string[]): number {
	let repo = "";
	let home = "";
	for (let i = 0; i < args.length; ) {
		const arg = args[i] as string;
		if (arg === "--from-repo") {
			repo = flagValue(args, i, arg);
			i += 2;
		} else if (arg === "--home") {
			home = flagValue(args, i, arg);
			i += 2;
		} else if (arg === "-h" || arg === "--help") {
			say(`usage: ${PROGRAM} next-nnn [--from-repo <path>] [--home <dir>]\n`);
			return 0;
		} else die(`unknown next-nnn flag: ${arg}`);
	}
	if (repo === "") repo = process.cwd();
	if (home !== "") {
		say(`${nextBundleNnn(`${repo}/${home}`)}\n`);
		return 0;
	}
	const dir = `${repo}/.agents/create-specs`;
	if (!isDirectory(dir)) {
		say("001\n");
		return 0;
	}
	let max = 0;
	for (const name of readdirSync(dir)) {
		if (!/^\d{3}_.*\.md$/.test(name) || !existsSync(`${dir}/${name}`)) continue;
		max = Math.max(max, Number.parseInt(name.slice(0, 3), 10));
	}
	say(`${formatNnn(max)}\n`);
	return 0;
}

const RESOLVE_PATH_HELP = `usage: ${PROGRAM} resolve-path --slug <slug> [flags]

Flags:
  --ephemeral/-e         LIGHT_MODE (implies no worktree)
  --later                LATER_MODE (implies no worktree)
  --pickup               PICKUP_MODE
  --bundle               BUNDLE_MODE (.agents/spec/ layout; needs --nnn unless --todo)
  --todo                 with --bundle, resolve to .agents/spec/todo/<slug>/plan.md
  --worktree <path>      WORKTREE_MODE with $WORKTREE_PATH
  --nnn <NNN>            zero-padded spec number
  --phase final|start    (default: final; 'start' = pre-move path for pickup)

Returns the resolved spec path per the flat-map in paths.md.
`;

export function resolvePathCommand(args: string[]): number {
	let slug = "";
	let light = false;
	let later = false;
	let pickup = false;
	let bundle = false;
	let todo = false;
	let worktree = "";
	let nnn = "";
	let phase = "final";
	for (let i = 0; i < args.length; ) {
		const arg = args[i] as string;
		switch (arg) {
			case "--slug":
				slug = flagValue(args, i, arg);
				i += 2;
				break;
			case "--worktree":
				worktree = flagValue(args, i, arg);
				i += 2;
				break;
			case "--nnn":
				nnn = flagValue(args, i, arg);
				i += 2;
				break;
			case "--phase":
				phase = flagValue(args, i, arg);
				i += 2;
				break;
			case "--ephemeral":
			case "-e":
				light = true;
				i += 1;
				break;
			case "--later":
				later = true;
				i += 1;
				break;
			case "--pickup":
				pickup = true;
				i += 1;
				break;
			case "--bundle":
				bundle = true;
				i += 1;
				break;
			case "--todo":
				todo = true;
				i += 1;
				break;
			case "-h":
			case "--help":
				say(RESOLVE_PATH_HELP);
				return 0;
			default:
				die(`unknown resolve-path flag: ${arg}`);
		}
	}
	if (slug === "") die("resolve-path requires --slug");
	if (phase !== "final" && phase !== "start")
		die("--phase must be 'final' or 'start'");
	if (light && worktree !== "")
		die(
			"invalid combination: --ephemeral forces no worktree (omit --worktree)",
		);
	if (later && worktree !== "")
		die("invalid combination: --later forces no worktree (omit --worktree)");
	if (later && pickup)
		die("invalid combination: --later and --pickup cannot co-occur");

	const prefix = worktree === "" ? "" : `${worktree.replace(/\/$/, "")}/`;
	const stateSpec = () => `${stateRoot()}/spec/${projectHash()}/${slug}.md`;
	const scratchTodo = () => `${scratchRoot()}/todo/${cwdHash()}/${slug}.md`;

	if (bundle) {
		if (todo) say(`${prefix}.agents/spec/todo/${slug}/plan.md\n`);
		else {
			if (nnn === "") die("--nnn required for --bundle (non-todo)");
			say(`${prefix}.agents/spec/${nnn}_${slug}/plan.md\n`);
		}
		return 0;
	}
	if (pickup) {
		if (light) {
			say(`${phase === "start" ? scratchTodo() : stateSpec()}\n`);
		} else if (phase === "start") {
			if (nnn === "") die("--nnn required for pickup --phase start (old NNN)");
			say(`${prefix}.agents/todo/${nnn}_${slug}.md\n`);
		} else {
			if (nnn === "") die("--nnn required for pickup --phase final (new NNN)");
			say(`${prefix}.agents/create-specs/${nnn}_${slug}.md\n`);
		}
		return 0;
	}
	if (later) {
		if (light) say(`${scratchTodo()}\n`);
		else {
			if (nnn === "") die("--nnn required for --later (standard)");
			say(`.agents/todo/${nnn}_${slug}.md\n`);
		}
		return 0;
	}
	if (light) {
		say(`${stateSpec()}\n`);
		return 0;
	}
	if (nnn === "") die("--nnn required for standard mode");
	say(`${prefix}.agents/create-specs/${nnn}_${slug}.md\n`);
	return 0;
}
