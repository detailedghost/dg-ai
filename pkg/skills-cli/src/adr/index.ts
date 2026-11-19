import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { die, type Handler, localDate, SpecError } from "../spec/shared";
import { slugify } from "../worktree/core";
import { findCommand } from "./find";
import { writeIndexes } from "./index-gen";
import { DEFAULT_LEVEL, type Level, parseLevel } from "./levels";
import { lintCommand } from "./lint";
import { ADR_DIR, DECISION_DIR, nextNumber, README_FILE, repoRoot, requireInitialized, TOC_FILE } from "./paths";
import { relevantCommand } from "./relevant";
import { AGENT_TEMPLATE, HUMAN_TEMPLATE, README_INTRO, TOC_INTRO, TOC_MARKER } from "./templates";

const USAGE = `usage: dg-skills adr <subcommand> [args]

Subcommands:
  init [--level <l>]      create docs/adr and .agents/decisions with their indexes
  new <title> --topic <t> [--covers <glob>...] [--level <l>]
                          write a paired ADR and decision, then refresh the indexes
  index                   rewrite both indexes below the marker
  lint                    check records against the rules
  relevant <files...>     print decisions whose covers match the files [--json]
  find <words...>         rank records by title and body hits [--json]
`;

interface Flags {
	positional: string[];
	values: Map<string, string[]>;
}

function parseFlags(args: string[], allowed: readonly string[], usage: string): Flags {
	const flags: Flags = { positional: [], values: new Map() };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (!arg.startsWith("--")) {
			flags.positional.push(arg);
			continue;
		}
		const value = args[i + 1];
		if (!allowed.includes(arg) || value === undefined) die(`usage: dg-skills adr ${usage}`);
		flags.values.set(arg, [...(flags.values.get(arg) ?? []), value]);
		i++;
	}
	return flags;
}

function levelFlag(flags: Flags): Level | undefined {
	const [level] = flags.values.get("--level") ?? [];
	return level === undefined ? undefined : parseLevel(level);
}

function ensureMarker(path: string): void {
	if (!readFileSync(path, "utf8").includes(TOC_MARKER)) die(`${path} has no ${TOC_MARKER} marker. Add the marker line where the index should start.`);
}

function writeIfAbsent(path: string, text: string): void {
	if (existsSync(path)) ensureMarker(path);
	else writeFileSync(path, text);
}

async function initCommand(args: string[]): Promise<number> {
	const flags = parseFlags(args, ["--level"], "init [--level <l>]");
	const level = levelFlag(flags) ?? DEFAULT_LEVEL;
	const root = repoRoot();
	for (const file of [TOC_FILE, README_FILE]) {
		if (existsSync(join(root, file))) ensureMarker(join(root, file));
	}
	mkdirSync(join(root, ADR_DIR), { recursive: true });
	mkdirSync(join(root, DECISION_DIR), { recursive: true });
	writeIfAbsent(join(root, TOC_FILE), `# Architecture decisions\n\n${TOC_INTRO}\n\n${TOC_MARKER}\n`);
	writeIfAbsent(join(root, README_FILE), `---\nlevel: ${level}\n---\n\n# Decisions\n\n${README_INTRO}\n\n${TOC_MARKER}\n`);
	return 0;
}

function writePair(adr: { path: string; text: string }, decision: { path: string; text: string }): void {
	const tmp = (path: string): string => `${path}.tmp`;
	try {
		writeFileSync(tmp(adr.path), adr.text);
		writeFileSync(tmp(decision.path), decision.text);
	} catch (error) {
		for (const path of [tmp(adr.path), tmp(decision.path)]) rmSync(path, { force: true });
		throw error;
	}
	try {
		renameSync(tmp(adr.path), adr.path);
		renameSync(tmp(decision.path), decision.path);
	} catch (error) {
		for (const path of [adr.path, tmp(adr.path), tmp(decision.path)]) rmSync(path, { force: true });
		throw error;
	}
}

async function newCommand(args: string[]): Promise<number> {
	const usage = "new <title> --topic <t> [--covers <glob>...] [--level <l>]";
	const root = repoRoot();
	requireInitialized(root);
	const flags = parseFlags(args, ["--topic", "--covers", "--level"], usage);
	const title = flags.positional.join(" ").trim();
	const [topic] = flags.values.get("--topic") ?? [];
	if (topic === undefined || topic.trim() === "") die(`--topic is required. usage: dg-skills adr ${usage}`);
	if (title === "") die("title is empty");
	const slug = slugify(title).replaceAll("_", "-");
	if (slug === "") die("title has no letters or digits to build a file name from");
	const level = levelFlag(flags);
	const key = `${nextNumber(root)}-${slug}`;
	const covers = flags.values.get("--covers") ?? [];
	const values: Record<string, string> = { title, date: localDate(), topic: topic.trim(), number: key.slice(0, 4), link: `../../${ADR_DIR}/${key}.md` };
	const fill = (template: string): string => template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? "");
	const adr = fill(level === undefined ? HUMAN_TEMPLATE.replace("Level: {{level}}\n", "") : HUMAN_TEMPLATE.replace("{{level}}", level));
	const decision = fill(AGENT_TEMPLATE).replace("covers: []", () => `covers: ${JSON.stringify(covers)}`);
	writePair({ path: join(root, ADR_DIR, `${key}.md`), text: adr }, { path: join(root, DECISION_DIR, `${key}.md`), text: decision });
	await writeIndexes(root);
	return 0;
}

async function indexCommand(args: string[]): Promise<number> {
	const root = repoRoot();
	requireInitialized(root);
	if (args.length > 0) die("usage: dg-skills adr index");
	await writeIndexes(root);
	return 0;
}

export const HANDLERS = new Map<string, Handler>([
	["init", initCommand],
	["new", newCommand],
	["index", indexCommand],
	["lint", lintCommand],
	["relevant", relevantCommand],
	["find", findCommand],
]);

function fail(message: string, status: number): number {
	process.stderr.write(`adr: ${message}\n`);
	return status;
}

export async function main(argv: string[]): Promise<number> {
	const [verb, ...rest] = argv;
	if (verb === undefined) {
		process.stdout.write(USAGE);
		return 2;
	}
	if (verb === "-h" || verb === "--help" || verb === "help") {
		process.stdout.write(USAGE);
		return 0;
	}
	const handler = HANDLERS.get(verb);
	if (handler === undefined) return fail(`unknown subcommand: ${verb} (try --help)`, 2);
	try {
		return await handler(rest);
	} catch (error) {
		if (error instanceof SpecError) return fail(error.message, error.status);
		return fail(error instanceof Error ? error.message : String(error), 1);
	}
}
