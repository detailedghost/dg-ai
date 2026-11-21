import { randomBytes } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { die, type Handler, localDate, SpecError } from "../spec/shared";
import { slugify } from "../worktree/core";
import { findCommand } from "./find";
import { writeIndexes } from "./index-gen";
import { DEFAULT_LEVEL, type Level, parseLevel } from "./levels";
import { lintCommand } from "./lint";
import { ADR_DIR, DECISION_DIR, nextNumber, README_FILE, refuseSymlink, repoRoot, requireInitialized, TOC_FILE } from "./paths";
import { repoLevel } from "./records";
import { relevantCommand } from "./relevant";
import { AGENT_TEMPLATE, fill, missingMarkerMessage, README_INTRO, renderHuman, TOC_INTRO, TOC_MARKER } from "./templates";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_SLUG = 80;

const USAGE = `usage: dg adr <subcommand> [args]

Subcommands:
  init [--level <l>]      create docs/adr and .agents/decisions with their indexes
  new <title> --topic <t> [--covers <glob>]... [--level <l>]
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

function parseFlags(args: string[], allowed: readonly string[], usage: string, repeatable: readonly string[] = []): Flags {
	const flags: Flags = { positional: [], values: new Map() };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (!arg.startsWith("--")) {
			flags.positional.push(arg);
			continue;
		}
		const value = args[i + 1];
		const repeated = flags.values.has(arg) && !repeatable.includes(arg);
		if (!allowed.includes(arg) || value === undefined || value.startsWith("--") || repeated) die(`usage: dg adr ${usage}`);
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
	if (!readFileSync(path, "utf8").includes(TOC_MARKER)) die(missingMarkerMessage(path));
}

function writeIfAbsent(path: string, text: string): void {
	refuseSymlink(path);
	if (!existsSync(path)) writeFileSync(path, text, { flag: "wx" });
}

function initCommand(args: string[]): number {
	const usage = "init [--level <l>]";
	const flags = parseFlags(args, ["--level"], usage);
	if (flags.positional.length > 0) die(`usage: dg adr ${usage}`);
	const requested = levelFlag(flags);
	const level = requested ?? DEFAULT_LEVEL;
	const root = repoRoot();
	for (const file of [TOC_FILE, README_FILE]) {
		if (existsSync(join(root, file))) ensureMarker(join(root, file));
	}
	if (requested !== undefined && existsSync(join(root, README_FILE)) && repoLevel(root) !== requested) {
		process.stderr.write(`adr: ${README_FILE} already sets level ${repoLevel(root)}. Kept it.\n`);
	}
	mkdirSync(join(root, ADR_DIR), { recursive: true });
	mkdirSync(join(root, DECISION_DIR), { recursive: true });
	writeIfAbsent(join(root, TOC_FILE), `# Architecture decisions\n\n${TOC_INTRO}\n\n${TOC_MARKER}\n`);
	writeIfAbsent(join(root, README_FILE), `---\nlevel: ${level}\n---\n\n# Decisions\n\n${README_INTRO}\n\n${TOC_MARKER}\n`);
	return 0;
}

function writePair(adr: { path: string; text: string }, decision: { path: string; text: string }): void {
	const files = [adr, decision].map((file) => ({
		...file,
		temp: join(dirname(file.path), `.${basename(file.path, ".md")}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`),
	}));
	if (files.some((file) => existsSync(file.path))) die(`${basename(adr.path)} already exists. Refusing to overwrite a record.`);
	const temps: string[] = [];
	const linked: string[] = [];
	try {
		for (const file of files) {
			const fd = openSync(file.temp, "wx");
			temps.push(file.temp);
			try {
				writeFileSync(fd, file.text);
			} finally {
				closeSync(fd);
			}
		}
		for (const file of files) {
			try {
				linkSync(file.temp, file.path);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EEXIST" || code === "EPERM" || code === "ENOTSUP") die(`cannot create ${basename(file.path)} (${code}). Refusing to overwrite a record.`);
				throw error;
			}
			linked.push(file.path);
		}
	} catch (error) {
		for (const path of linked) rmSync(path, { force: true });
		throw error;
	} finally {
		for (const path of temps) rmSync(path, { force: true });
	}
}

function newCommand(args: string[]): number {
	const usage = "new <title> --topic <t> [--covers <glob>]... [--level <l>]";
	const root = repoRoot();
	requireInitialized(root);
	const flags = parseFlags(args, ["--topic", "--covers", "--level"], usage, ["--covers"]);
	const rawTitle = flags.positional.join(" ");
	const title = rawTitle.trim();
	const [topic] = flags.values.get("--topic") ?? [];
	if (topic === undefined || topic.trim() === "") die(`--topic is required. usage: dg adr ${usage}`);
	if (title === "") die("title is empty");
	if (CONTROL_CHARS.test(rawTitle) || CONTROL_CHARS.test(topic)) die("title and topic must not contain control characters");
	const slug = slugify(title).replaceAll("_", "-").slice(0, MAX_SLUG).replace(/-+$/, "");
	if (slug === "") die("title has no letters or digits to build a file name from");
	const level = levelFlag(flags);
	if ((flags.values.get("--covers") ?? []).some((pattern) => pattern.trim() === "")) die(`--covers must not be blank. usage: dg adr ${usage}`);
	const key = `${nextNumber(root)}-${slug}`;
	const covers = flags.values.get("--covers") ?? [];
	const values: Record<string, string> = { title, date: localDate(), topic: topic.trim(), number: key.slice(0, 4), covers: JSON.stringify(covers), link: `../../${ADR_DIR}/${key}.md` };
	const adr = renderHuman(values, level);
	const decision = fill(AGENT_TEMPLATE, values);
	writePair({ path: join(root, ADR_DIR, `${key}.md`), text: adr }, { path: join(root, DECISION_DIR, `${key}.md`), text: decision });
	writeIndexes(root);
	return 0;
}

function indexCommand(args: string[]): number {
	const root = repoRoot();
	requireInitialized(root);
	if (args.length > 0) die("usage: dg adr index");
	writeIndexes(root);
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
