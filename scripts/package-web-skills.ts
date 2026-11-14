/**
 * Validate and package the web-only skills in web/skills for Claude chat uploads.
 *
 *   bun scripts/package-web-skills.ts                       validate only
 *   bun scripts/package-web-skills.ts --out dist --version 5.11.0
 *       writes dg-web-skills-<version>.zip: one dg-<name>.zip per skill (the skill folder at
 *       its top level, the layout claude.ai expects) plus UPLOAD.md
 *   bun scripts/package-web-skills.ts --refresh-sources     re-pin web/sources.json after a
 *       deliberate review of the first-class sources a web skill was adapted from
 *
 * The first-class skills under plugins/dg/skills are never read for packaging or changed.
 */
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export const REPO = join(import.meta.dir, "..");
export const WEB = join(REPO, "web");
export const WEB_SKILLS = join(WEB, "skills");
export const SOURCES_FILE = join(WEB, "sources.json");
export const SHARED_FILES = ["dg-theme.css", "dg-icons.js"] as const;

export const NAME_PATTERN = /^dg-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 200;
export const ALLOWED_EXTENSIONS = [".md", ".html", ".css", ".js", ".json"] as const;
export const SKILL_BYTES_MAX = 512 * 1024;

/** Instructions a chat model must never be told to run. Each is a whole-word match. */
export const FORBIDDEN = [
	{ pattern: /\bdg-skills\b/, why: "the dg-skills CLI" },
	{ pattern: /\bdg-agent\b/, why: "the dg-agent CLI" },
	{ pattern: /\bdg-daemon\b/, why: "the dg-daemon service" },
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
	if (!existsSync(WEB_SKILLS)) return [];
	return readdirSync(WEB_SKILLS)
		.filter((name) => statSync(join(WEB_SKILLS, name)).isDirectory())
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

export function validateSkill(name: string, root: string = WEB_SKILLS): Finding[] {
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
		if (readFileSync(copy, "utf8") !== readFileSync(join(WEB, "shared", shared), "utf8"))
			add(`assets/${shared}`, `differs from web/shared/${shared}; copy the shared file over it`);
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

/** Source files whose content changed since the web skill was last reviewed against them. */
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
					problem: "changed since web/skills/" + skill + " was adapted from it. Review the web skill, then run scripts/package-web-skills.ts --refresh-sources",
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

function zip(cwd: string, out: string, entries: string[]): void {
	const result = Bun.spawnSync(["zip", "-q", "-X", "-r", out, ...entries], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`zip ${out}: ${result.stderr.toString()}`);
}

export function uploadGuide(version: string, names: string[]): string {
	return [
		`# DeeGee web skills ${version}`,
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

/** Builds dg-web-skills-<version>.zip in outDir and returns its path. */
export function packageWebSkills(outDir: string, version: string): string {
	const names = skillNames();
	if (names.length === 0) throw new Error("web/skills holds no skills");
	const stage = mkdtempSync(join(tmpdir(), "dg-web-skills-"));
	try {
		const zips = join(stage, "zips");
		mkdirSync(zips);
		for (const name of names) {
			const copy = join(stage, "tree", name);
			for (const file of filesUnder(join(WEB_SKILLS, name))) {
				mkdirSync(join(copy, file, ".."), { recursive: true });
				copyFileSync(join(WEB_SKILLS, name, file), join(copy, file));
			}
			zip(join(stage, "tree"), join(zips, `${name}.zip`), [name]);
		}
		writeFileSync(join(zips, "UPLOAD.md"), uploadGuide(version, names));
		mkdirSync(outDir, { recursive: true });
		const out = join(outDir, `dg-web-skills-${version}.zip`);
		rmSync(out, { force: true });
		zip(zips, out, [...names.map((name) => `${name}.zip`), "UPLOAD.md"]);
		return out;
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
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
		console.log(`${skillNames().length} web skills are valid.`);
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
