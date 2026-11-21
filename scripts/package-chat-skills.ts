/**
 * Validate and package the chat-only skills in chat/skills for Claude chat uploads.
 *
 *   bun scripts/package-chat-skills.ts                       validate only
 *   bun scripts/package-chat-skills.ts --out dist --version 5.11.0
 *       writes dg-chat-skills-<version>.zip: one dg-<name>.zip per skill (the skill folder at
 *       its top level, the layout claude.ai expects) plus UPLOAD.md
 *   bun scripts/package-chat-skills.ts --refresh-sources     re-pin chat/sources.json after a
 *       deliberate review of the first-class sources a chat skill was adapted from
 *
 * The first-class skills under plugins/dg/skills are never read for packaging or changed.
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { zipEntries } from "./zip";

export const REPO = join(import.meta.dir, "..");
export const CHAT = join(REPO, "chat");
export const CHAT_SKILLS = join(CHAT, "skills");
export const SOURCES_FILE = join(CHAT, "sources.json");
export const SHARED_FILES = ["dg-theme.css", "dg-icons.js"] as const;

export const NAME_PATTERN = /^dg-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 200;
export const ALLOWED_EXTENSIONS = [".md", ".html", ".css", ".js", ".json"] as const;
export const SKILL_BYTES_MAX = 512 * 1024;

/** Instructions a chat model must never be told to run. Each is a whole-word match. */
export const FORBIDDEN = [
	{ pattern: /(^|```|\$\(|\$[ \t]|:[ \t]|&&|\|\||[|;"'`])[ \t]*dg[ \t]+[a-z]/m, why: "the dg CLI" },
	{ pattern: /\bbootstrap\.(sh|ps1)\b/, why: "the installer" },
	{ pattern: /\bcurl\s/, why: "a curl command" },
	{ pattern: /\bwget\s/, why: "a wget command" },
	{ pattern: /(^|[\s`$(])git\s+[a-z]/m, why: "a git command" },
	{ pattern: /(^|[\s`$(])gh\s+[a-z]/m, why: "a gh command" },
	{ pattern: /(^|[\s`$(])(bun|bunx|npm|npx|pnpm|yarn|mise)\s+[a-z]/m, why: "a package manager or task runner" },
	{ pattern: /\$DG_[A-Z_]+|\bDG_[A-Z][A-Z_]+=/, why: "a dg environment variable" },
	{ pattern: /```(sh|bash|shell|zsh|powershell|pwsh|console)\b/, why: "a shell block" },
] as const;

/** Assets may name exactly these URLs: XML namespaces, never fetched. */
const ALLOWED_ASSET_URLS = new Set(["http://www.w3.org/2000/svg"]);

export type Finding = { skill: string; file: string; problem: string };
export type SourcePin = { source: string; files: Record<string, string> };
export type Sources = Record<string, SourcePin>;

export function sha256(bytes: string | Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function skillNames(): string[] {
	if (!existsSync(CHAT_SKILLS)) return [];
	return readdirSync(CHAT_SKILLS)
		.filter((name) => statSync(join(CHAT_SKILLS, name)).isDirectory())
		.sort();
}

export function filesUnder(root: string): string[] {
	const out: string[] = [];
	const visit = (dir: string) => {
		for (const name of readdirSync(dir).sort()) {
			const abs = join(dir, name);
			if (statSync(abs).isDirectory()) visit(abs);
			else out.push(relative(root, abs).split(sep).join("/"));
		}
	};
	visit(root);
	return out;
}

/** The YAML frontmatter of a SKILL.md as flat key/value strings, or null when it has none. */
export function frontmatter(text: string): Record<string, string> | null {
	const match = text.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) return null;
	const out: Record<string, string> = {};
	for (const line of (match[1] as string).split("\n")) {
		const kv = line.match(/^([a-z][a-z-]*):\s*(.*)$/);
		if (kv) out[kv[1] as string] = (kv[2] as string).trim();
	}
	return out;
}

export function validateSkill(name: string, root: string = CHAT_SKILLS): Finding[] {
	const dir = join(root, name);
	const findings: Finding[] = [];
	const add = (file: string, problem: string) => findings.push({ skill: name, file, problem });

	if (!NAME_PATTERN.test(name) || name.length > NAME_MAX)
		add("", `folder name must match ${NAME_PATTERN} and be at most ${NAME_MAX} characters`);
	if (/anthropic|claude/.test(name)) add("", "names may not contain a reserved word");

	const skillPath = join(dir, "SKILL.md");
	if (!existsSync(skillPath)) {
		add("SKILL.md", "missing");
		return findings;
	}
	const fm = frontmatter(readFileSync(skillPath, "utf8"));
	if (!fm) add("SKILL.md", "no YAML frontmatter");
	else {
		const keys = Object.keys(fm).sort();
		if (keys.join(",") !== "description,name") add("SKILL.md", `frontmatter must hold only name and description, found ${keys.join(", ")}`);
		if (fm.name !== name) add("SKILL.md", `frontmatter name "${fm.name ?? ""}" must match the folder name`);
		const description = fm.description ?? "";
		if (!description) add("SKILL.md", "empty description");
		if (description.length > DESCRIPTION_MAX)
			add("SKILL.md", `description is ${description.length} characters, the upload limit is ${DESCRIPTION_MAX}`);
		if (/[<>]/.test(description)) add("SKILL.md", "description may not contain < or >");
	}

	let bytes = 0;
	for (const file of filesUnder(dir)) {
		const abs = join(dir, file);
		bytes += statSync(abs).size;
		if (!ALLOWED_EXTENSIONS.some((ext) => file.endsWith(ext))) {
			add(file, `file type not allowed (allowed: ${ALLOWED_EXTENSIONS.join(" ")})`);
			continue;
		}
		const text = readFileSync(abs, "utf8");
		for (const { pattern, why } of FORBIDDEN) if (pattern.test(text)) add(file, `mentions ${why}`);
		if (file.startsWith("assets/")) {
			for (const url of text.match(/\bhttps?:\/\/[^\s"'`)<>]+/g) ?? [])
				if (!ALLOWED_ASSET_URLS.has(url)) add(file, `links an external URL: ${url}`);
			if (/<script[^>]*\ssrc=/i.test(text)) add(file, "loads a script by src");
			if (/<link[^>]*\shref=/i.test(text)) add(file, "loads a stylesheet or font by href");
			if (/@import\s/.test(text)) add(file, "uses a CSS @import");
		}
	}
	if (bytes > SKILL_BYTES_MAX) add("", `skill is ${bytes} bytes, over the ${SKILL_BYTES_MAX} byte budget`);

	for (const shared of SHARED_FILES) {
		const copy = join(dir, "assets", shared);
		if (!existsSync(copy)) continue;
		if (readFileSync(copy, "utf8") !== readFileSync(join(CHAT, "shared", shared), "utf8"))
			add(`assets/${shared}`, `differs from chat/shared/${shared}; copy the shared file over it`);
	}

	for (const match of readFileSync(skillPath, "utf8").matchAll(/\]\(([^)#\s]+)\)/g)) {
		const target = match[1] as string;
		if (/^[a-z]+:/.test(target)) continue;
		if (!existsSync(join(dir, target))) add("SKILL.md", `links ${target}, which is not in the skill`);
	}
	return findings;
}

export function readSources(): Sources {
	return existsSync(SOURCES_FILE) ? (JSON.parse(readFileSync(SOURCES_FILE, "utf8")) as Sources) : {};
}

/** Source files whose content changed since the chat skill was last reviewed against them. */
export function staleSources(sources: Sources = readSources()): Finding[] {
	const findings: Finding[] = [];
	for (const [skill, pin] of Object.entries(sources)) {
		for (const [file, hash] of Object.entries(pin.files)) {
			const abs = join(REPO, pin.source, file);
			const actual = existsSync(abs) ? sha256(readFileSync(abs)) : "missing";
			if (actual !== hash)
				findings.push({
					skill,
					file: `${pin.source}/${file}`,
					problem: "changed since chat/skills/" + skill + " was adapted from it. Review the chat skill, then run scripts/package-chat-skills.ts --refresh-sources",
				});
		}
	}
	return findings;
}

export function refreshSources(): Sources {
	const sources = readSources();
	for (const pin of Object.values(sources))
		for (const file of Object.keys(pin.files)) pin.files[file] = sha256(readFileSync(join(REPO, pin.source, file)));
	writeFileSync(SOURCES_FILE, `${JSON.stringify(sources, null, "\t")}\n`);
	return sources;
}

export function uploadGuide(version: string, names: string[]): string {
	return [
		`# DeeGee chat skills ${version}`,
		"",
		"Upload each ZIP as a separate skill in Claude: Customize, then Skills, then Upload a skill.",
		"Code execution must be on in Settings, under Capabilities. On a Team or Enterprise plan,",
		"an owner can add them for the whole organization instead.",
		"",
		...names.map((name) => `- ${name}.zip`),
		"",
		"These skills only read and write in the chat. They run no commands and reach nothing on your computer.",
		"",
	].join("\n");
}

/** Builds dg-chat-skills-<version>.zip in outDir and returns its path. */
export function packageWebSkills(outDir: string, version: string): string {
	const names = skillNames();
	if (names.length === 0) throw new Error("chat/skills holds no skills");
	const bundle = zipEntries([
		...names.map((name) => ({
			name: `${name}.zip`,
			data: zipEntries(
				filesUnder(join(CHAT_SKILLS, name)).map((file) => ({
					name: `${name}/${file}`,
					data: readFileSync(join(CHAT_SKILLS, name, file)),
				})),
			),
		})),
		{ name: "UPLOAD.md", data: Buffer.from(uploadGuide(version, names)) },
	]);
	mkdirSync(outDir, { recursive: true });
	const out = join(outDir, `dg-chat-skills-${version}.zip`);
	writeFileSync(out, bundle);
	return out;
}

function main(argv: string[]): number {
	const arg = (flag: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	if (argv.includes("--refresh-sources")) {
		refreshSources();
		console.log(`Pinned ${SOURCES_FILE}`);
		return 0;
	}
	const findings = [...skillNames().flatMap((name) => validateSkill(name)), ...staleSources()];
	for (const f of findings) console.error(`${f.skill}${f.file ? `/${f.file}` : ""}: ${f.problem}`);
	if (findings.length > 0) return 1;
	const out = arg("--out");
	if (!out) {
		console.log(`${skillNames().length} chat skills are valid.`);
		return 0;
	}
	const version = arg("--version");
	if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
		console.error("--out needs --version <x.y.z>");
		return 1;
	}
	console.log(packageWebSkills(out, version));
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
