import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { readStdinLine } from "../spec/shared";
import { resolveSkillAsset } from "../utils/skill-assets";
import { assertNotInstalledCache, assertNotSelfMove, findSourceCheckoutPluginRoot } from "./checkout";
import { ajvValidate } from "./manifest";
import type { PluginManifest } from "./types";

const SECRET_PATTERNS = [/AKIA[A-Z0-9]{16}/, /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9+/]{20,}/i];

const INJECTION_PATTERNS = [
	"ignore previous instructions",
	"disregard",
	"you are now",
	"override your",
	"system prompt",
];

function scanRecipeInjection(recipe: string): string[] {
	const lower = recipe.toLowerCase();
	const hits: string[] = [];
	for (const pattern of INJECTION_PATTERNS) {
		const idx = lower.indexOf(pattern);
		if (idx !== -1) {
			const span = recipe.slice(Math.max(0, idx - 10), idx + pattern.length + 20);
			hits.push(`  ⚠ "${pattern}" → ...${span}...`);
		}
	}
	return hits;
}

/** `git config user.name`; undefined if git is unavailable or the value is unset. */
function gitConfigUserName(): string | undefined {
	const proc = Bun.spawnSync(["git", "config", "user.name"]);
	if (proc.exitCode !== 0) return undefined;
	const name = proc.stdout.toString().trim();
	return name || undefined;
}

export function cmdPluginDraft(args: string[]): number {
	let name = "";
	let outDir = "";
	const skills: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--skill" && i + 1 < args.length) skills.push(args[++i]);
		else if (args[i] === "--out" && i + 1 < args.length) outDir = args[++i];
		else if (!args[i].startsWith("-")) name = args[i];
	}

	if (!name || skills.length === 0) {
		process.stderr.write("Usage: skill-publish plugin draft <name> --skill <slug> [--skill <slug>...] [--out <dir>]\n");
		return 1;
	}

	const targetDir = outDir ? resolve(outDir) : process.cwd();
	mkdirSync(targetDir, { recursive: true });

	const manifest: PluginManifest = { name, description: `Claude Code plugin: ${name}`, skills };
	const owner = gitConfigUserName();
	if (owner) manifest.owner = owner;

	const outPath = join(targetDir, `${name}.plugin.json`);
	writeFileSync(outPath, JSON.stringify(manifest, null, 2));
	process.stdout.write(`${outPath}\n`);
	process.stderr.write(`Plugin manifest drafted at ${outPath}\nPlease review before running plugin generate.\n`);
	return 0;
}

/** Resolve a `skills[]` entry to its source directory. A bare slug resolves under the invoking
 * user's own home directory, at .claude/skills/<slug> (the explicit, bounded "local" source); an
 * entry containing "/" is a path (absolute or cwd-relative). */
function resolveSkillDir(entry: string): string {
	return entry.includes("/") ? resolve(entry) : join(homedir(), ".claude", "skills", entry);
}

function validateSkillsResolve(skills: string[]): { errors: string[]; dirs: Map<string, string> } {
	const errors: string[] = [];
	const dirs = new Map<string, string>();
	for (const entry of skills) {
		const dir = resolveSkillDir(entry);
		if (!existsSync(join(dir, "SKILL.md"))) {
			errors.push(`Skill "${entry}" not found: no SKILL.md in ${dir}`);
			continue;
		}
		dirs.set(entry, dir);
	}
	return { errors, dirs };
}

let _pluginSchemaCache: Record<string, unknown> | null = null;

function loadPluginSchema(): Record<string, unknown> {
	if (_pluginSchemaCache) return _pluginSchemaCache;
	const path = resolveSkillAsset("skill-publish", "references/plugin.schema.json");
	_pluginSchemaCache = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	return _pluginSchemaCache;
}

async function validatePluginWithAjv(manifest: Record<string, unknown>): Promise<string[]> {
	let schema: Record<string, unknown>;
	try {
		schema = loadPluginSchema();
	} catch (e) {
		return [e instanceof Error ? e.message : String(e)];
	}
	return ajvValidate(manifest, schema);
}

async function validatePluginManifest(manifest: Record<string, unknown>): Promise<string[]> {
	const errors = await validatePluginWithAjv(manifest);
	const skills = manifest.skills;
	if (Array.isArray(skills)) errors.push(...validateSkillsResolve(skills as string[]).errors);
	return errors;
}

export async function cmdPluginValidate(args: string[]): Promise<number> {
	const manifestPath = args[0];
	if (!manifestPath) {
		process.stderr.write("Usage: skill-publish plugin validate <manifest-path>\n");
		return 1;
	}

	const absPath = resolve(manifestPath);
	if (!existsSync(absPath)) {
		process.stderr.write(`File not found: ${absPath}\n`);
		return 1;
	}

	let manifest: Record<string, unknown>;
	try {
		manifest = JSON.parse(readFileSync(absPath, "utf-8")) as Record<string, unknown>;
	} catch (e) {
		process.stderr.write(`Invalid JSON: ${e}\n`);
		return 1;
	}

	const errors = await validatePluginManifest(manifest);
	if (errors.length > 0) {
		process.stderr.write(`${errors.join("\n")}\n`);
		return 1;
	}
	return 0;
}

/** Recursively list files under dir (absolute paths), skipping symlinks. */
function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const st = lstatSync(full);
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) out.push(...listFilesRecursive(full));
		else out.push(full);
	}
	return out;
}

interface PluginWallResult {
	hardErrors: string[];
	gateWarnings: string[];
}

/** Secret wall for `plugin generate`, run over the staged skill files: real secrets hard-block;
 * every home-rooted path and injection-pattern hit is a gate warning only (no path allowlist). */
async function runPluginSecretWall(skillsDir: string): Promise<PluginWallResult> {
	const hardErrors: string[] = [];
	const gateWarnings: string[] = [];

	const escapedHome = homedir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const homeRe = new RegExp(`${escapedHome}|\\$HOME|~/|homedir\\(\\)`, "g");

	for (const file of listFilesRecursive(skillsDir)) {
		const rel = relative(skillsDir, file);
		const text = readFileSync(file, "utf-8");

		for (const pattern of SECRET_PATTERNS) {
			if (pattern.test(text)) hardErrors.push(`[secret] "${rel}" matches a secret-shaped pattern (${pattern}).`);
		}
		for (const m of new Set(text.match(homeRe) ?? [])) gateWarnings.push(`[path] "${rel}": ${m}`);
		for (const hit of scanRecipeInjection(text)) gateWarnings.push(`[injection] "${rel}":${hit}`);
	}

	const gitleaksCheck = Bun.spawnSync(["which", "gitleaks"]);
	if (gitleaksCheck.exitCode !== 0) {
		process.stderr.write("[Layer 2] WARNING: gitleaks binary not found. Secret scanning via gitleaks is SKIPPED.\n");
	} else {
		const scan = Bun.spawnSync(["gitleaks", "detect", "--source", skillsDir, "--no-git", "--exit-code", "1"]);
		if (scan.exitCode !== 0) {
			hardErrors.push(`[gitleaks] finding in plugin skill files:\n${scan.stdout.toString()}\n${scan.stderr.toString()}`);
		}
	}

	return { hardErrors, gateWarnings };
}

/** Every gate warning is shown but never auto-blocks — only a hard secret/gitleaks hit does. */
async function pluginHumanGate(
	manifest: PluginManifest,
	skillDirs: Map<string, string>,
	skillsTmpDir: string,
	gateWarnings: string[],
): Promise<boolean> {
	process.stderr.write("\n── What will be shipped ──────────────────────────────────────────\n");
	process.stderr.write(`  Plugin: ${manifest.name}\n`);
	process.stderr.write(`  Skills: ${[...skillDirs.keys()].join(", ")}\n`);
	process.stderr.write("  Files:\n");
	for (const f of listFilesRecursive(skillsTmpDir).sort()) {
		process.stderr.write(`    ${relative(skillsTmpDir, f)}\n`);
	}

	if (gateWarnings.length > 0) {
		process.stderr.write("\n⚠ Review before shipping (surfaced, not blocked):\n");
		for (const w of gateWarnings) process.stderr.write(`  ${w}\n`);
	}

	process.stderr.write("\nShip this? [y/N] ");
	const line = await readStdinLine();
	return line?.trim() === "y";
}

export async function cmdPluginGenerate(args: string[]): Promise<number> {
	let manifestPath = "";
	let root = "";
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--root" && i + 1 < args.length) root = args[++i];
		else if (!args[i].startsWith("-")) manifestPath = args[i];
	}

	if (!manifestPath) {
		process.stderr.write("Usage: skill-publish plugin generate <manifest-path> [--root <plugins/dg>]\n");
		return 1;
	}

	const absManifest = resolve(manifestPath);
	if (!existsSync(absManifest)) {
		process.stderr.write(`Manifest not found: ${absManifest}\n`);
		return 1;
	}

	let manifest: PluginManifest;
	try {
		manifest = JSON.parse(readFileSync(absManifest, "utf-8")) as PluginManifest;
	} catch (e) {
		process.stderr.write(`Invalid manifest JSON: ${e}\n`);
		return 1;
	}

	if (!manifest.name || !/^[a-z][a-z0-9-]*$/.test(manifest.name)) {
		process.stderr.write(`Unsafe or missing plugin name "${manifest.name}" — must match ^[a-z][a-z0-9-]*$.\n`);
		return 1;
	}

	const ajvErrors = await validatePluginWithAjv(manifest as unknown as Record<string, unknown>);
	const { errors: skillErrors, dirs: skillDirs } = validateSkillsResolve(manifest.skills ?? []);
	const errors = [...ajvErrors, ...skillErrors];
	if (errors.length > 0) {
		process.stderr.write(`${errors.join("\n")}\n`);
		return 1;
	}

	const pluginRoot = root ? resolve(root) : findSourceCheckoutPluginRoot();
	if (!pluginRoot || !existsSync(join(pluginRoot, ".claude-plugin", "plugin.json"))) {
		process.stderr.write(
			`Not a dg-ai source checkout's plugins/dg (no .claude-plugin/plugin.json in ${pluginRoot ?? (root || "the discovered root")}).\n`,
		);
		return 1;
	}
	try {
		assertNotInstalledCache(pluginRoot);
		for (const dir of skillDirs.values()) {
			assertNotSelfMove(dir, join(pluginRoot, "skills", basename(dir)));
		}
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		return 1;
	}

	const tmpBase = mkdtempSync(join(tmpdir(), "skill-publish-plugin-"));
	try {
		const skillsTmpDir = join(tmpBase, "skills");
		mkdirSync(skillsTmpDir, { recursive: true });
		for (const dir of skillDirs.values()) {
			cpSync(dir, join(skillsTmpDir, basename(dir)), { recursive: true });
		}

		const { hardErrors, gateWarnings } = await runPluginSecretWall(skillsTmpDir);
		if (hardErrors.length > 0) {
			process.stderr.write(`${hardErrors.join("\n")}\n`);
			return 1;
		}

		const passed = await pluginHumanGate(manifest, skillDirs, skillsTmpDir, gateWarnings);
		if (!passed) return 1;

		const written: string[] = [];
		for (const dir of skillDirs.values()) {
			const slug = basename(dir);
			const staged = join(skillsTmpDir, slug);
			const dest = join(pluginRoot, "skills", slug);
			rmSync(dest, { recursive: true, force: true });
			mkdirSync(dirname(dest), { recursive: true });
			cpSync(staged, dest, { recursive: true });
			written.push(dest);
		}

		for (const path of written) process.stdout.write(`${path}\n`);
		return 0;
	} finally {
		rmSync(tmpBase, { recursive: true, force: true });
	}
}
