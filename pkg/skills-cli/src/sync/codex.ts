/** `dg-skills sync codex` — reconciles Codex-specific status-line, hook, and skill/agent-import behavior. */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { scratchRoot } from "@dg/common/node";
import { pruneStale } from "./manifest";
import {
	mergeAgentSources,
	mergeSkillSources,
	resolveClaudeAgentsRoot,
	resolveClaudeSkillsRoot,
	resolvePluginAgentsRoot,
	resolvePluginSkillsRoot,
} from "./roots";
import { rewriteScratchPaths } from "./scratch-rewrite";
import { copyTree, isSymlink, rewriteTreeScratchPaths } from "./tree-copy";
import type { SyncContext, SyncTarget } from "./types";
import { SyncReport } from "./types";

export type CodexFlags = Record<string, never>;

const STATUS_LINE =
	'status_line = ["current-dir", "model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit"]';
const TERMINAL_TITLE = 'terminal_title = ["spinner", "project", "model"]';
const CONTEXT7_ARGS = 'args = ["-y", "@upstash/context7-mcp"]';
const CONTEXT7_ENV = 'env_vars = ["CONTEXT7_API_KEY"]';
const CONTEXT7_BEARER = 'bearer_token_env_var = "CONTEXT7_API_KEY"';
const CLAUDE_STATUSLINE_PATTERN =
	/(^|[ /])ai\/claude\/statusline-command\.sh($|[ \t])|(^|[ /])claude\/statusline-command\.sh($|[ \t])/;

const CLAUDE_TO_CODEX_MODELS: Record<string, string> = {
	opus: "gpt-5.6-sol",
	sonnet: "gpt-5.6-terra",
	haiku: "gpt-5.6-luna",
};

interface Paths {
	codexHome: string;
	claudeHome: string;
	agentsHome: string;
	codexConfig: string;
	codexHooks: string;
	codexSkillsDir: string;
	codexAgentsDir: string;
	claudeSettings: string;
	importManifest: string;
	hooksRoot: string | undefined;
	rtkHook: string | undefined;
	applyPatchInputsHook: string | undefined;
}

function paths(ctx: SyncContext): Paths {
	const codexHome = ctx.env.CODEX_HOME || join(ctx.home, ".codex");
	const claudeHome = ctx.env.CLAUDE_HOME || join(ctx.home, ".claude");
	const agentsHome = ctx.env.AGENTS_HOME || join(ctx.home, ".agents");
	const codexSkillsDir = ctx.env.CODEX_SKILLS_DIR || join(codexHome, "skills");
	const hooksRoot = ctx.env.HOOKS_ROOT || undefined;
	return {
		codexHome,
		claudeHome,
		agentsHome,
		codexConfig: ctx.env.CODEX_CONFIG || join(codexHome, "config.toml"),
		codexHooks: ctx.env.CODEX_HOOKS || join(codexHome, "hooks.json"),
		codexSkillsDir,
		codexAgentsDir: ctx.env.CODEX_AGENTS_DIR || join(codexHome, "agents"),
		claudeSettings: ctx.env.CLAUDE_SETTINGS || join(claudeHome, "settings.json"),
		importManifest: join(codexSkillsDir, ".codex-sync-imported"),
		hooksRoot,
		rtkHook: hooksRoot ? join(hooksRoot, "rtk-codex-hook.sh") : undefined,
		applyPatchInputsHook: hooksRoot ? join(hooksRoot, "codex-apply-patch-inputs.sh") : undefined,
	};
}

function isExecutable(path: string): boolean {
	try {
		return (statSync(path).mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

function hooksAvailable(p: Paths): boolean {
	return !!p.rtkHook && !!p.applyPatchInputsHook && isExecutable(p.rtkHook) && isExecutable(p.applyPatchInputsHook);
}

function hasYamlFrontmatter(text: string): boolean {
	const lines = text.split(/\r?\n/);
	return lines[0] === "---" && lines.slice(1).some((line) => line === "---");
}

function firstContentLine(text: string): string | undefined {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		return line
			.replace(/`([^`]+)`/g, "$1")
			.replace(/\*\*([^*]+)\*\*/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
			.replace(/[<>]/g, "")
			.trim();
	}
	return undefined;
}

function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

const BOM = String.fromCharCode(0xfeff);

function stripBom(text: string): string {
	return text.charCodeAt(0) === BOM.charCodeAt(0) ? text.slice(1) : text;
}

function ensureSkillFrontmatter(name: string, skillDir: string): void {
	const skillPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillPath)) return;
	const text = readFileSync(skillPath, "utf8");
	if (hasYamlFrontmatter(text)) return;
	const description = firstContentLine(text) ?? `Imported Claude skill: ${name}.`;
	const frontmatter = ["---", `name: ${yamlScalar(name)}`, `description: ${yamlScalar(description)}`, "---", "", ""].join(
		"\n",
	);
	writeFileSync(skillPath, frontmatter + stripBom(text));
}

const MAX_SKILL_DESCRIPTION_CHARS = 180;

function shortDescription(description: string): string {
	const text = description.replace(/\s+/g, " ").trim();
	const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? text;
	if (sentence.length <= MAX_SKILL_DESCRIPTION_CHARS) return sentence;
	const cut = sentence.slice(0, MAX_SKILL_DESCRIPTION_CHARS - 1);
	const wordEnd = cut.lastIndexOf(" ");
	return `${(wordEnd > 0 ? cut.slice(0, wordEnd) : cut).replace(/[,;:\s]+$/, "")}…`;
}

function readDescription(lines: string[], first: number, close: number): string | undefined {
	const value = lines[first].replace(/^description\s*:\s*/, "").trim();
	if (/^[>|][+-]?$/.test(value)) {
		const body: string[] = [];
		for (let i = first + 1; i < close && /^(\s|$)/.test(lines[i]); i++) body.push(lines[i].trim());
		return body.join(value.startsWith(">") ? " " : "\n").trim();
	}
	if (value.startsWith('"')) {
		try {
			return JSON.parse(value) as string;
		} catch {
			return undefined;
		}
	}
	if (value.startsWith("'")) {
		if (!value.endsWith("'")) return undefined;
		return value.slice(1, -1).replaceAll("''", "'");
	}
	return value || undefined;
}

function shortenSkillDescription(skillDir: string): void {
	const skillPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillPath)) return;
	const lines = readFileSync(skillPath, "utf8").split("\n");
	if (lines[0]?.trimEnd() !== "---") return;
	const close = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
	if (close < 0) return;
	const first = lines.findIndex((line, i) => i > 0 && i < close && /^description\s*:/.test(line));
	if (first < 0) return;
	const description = readDescription(lines, first, close);
	if (description === undefined) return;
	const short = shortDescription(description);
	if (short === description) return;
	let last = first + 1;
	while (last < close && /^(\s|$)/.test(lines[last])) last++;
	lines.splice(first, last - first, `description: ${yamlScalar(short)}`);
	writeFileSync(skillPath, lines.join("\n"));
}

function hideNonCodexSyncSkill(name: string, skillDir: string): void {
	const descriptions: Record<string, string> = {
		"copilot-sync":
			"Hidden non-Codex sync target. Do not suggest or route to this from Codex sessions unless the user explicitly asks to maintain Copilot outside Codex.",
		"opencode-sync":
			"Hidden non-Codex sync target. Do not suggest or route to this from Codex sessions unless the user explicitly asks to maintain OpenCode outside Codex.",
	};
	const description = descriptions[name];
	if (!description) return;
	const skillPath = join(skillDir, "SKILL.md");
	if (!existsSync(skillPath)) return;
	let text = readFileSync(skillPath, "utf8");
	const descriptionLine = `description: ${JSON.stringify(description)}`;
	if (/^description:.*$/m.test(text)) text = text.replace(/^description:.*$/m, descriptionLine);
	else text = text.replace(/^name:.*$/m, `$&\n${descriptionLine}`);
	if (/^user-invocable:.*$/m.test(text)) text = text.replace(/^user-invocable:.*$/m, "user-invocable: false");
	else text = text.replace(/^description:.*$/m, "$&\nuser-invocable: false");
	writeFileSync(skillPath, text);
}

function walkMdFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && full.endsWith(".md")) out.push(full);
		}
	};
	if (existsSync(root)) walk(root);
	return out;
}

const FRONTMATTER_BLOCK_PATTERN = new RegExp(`^(?:${BOM})?---[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n---[ \\t]*(?=\\r?\\n|$)`);

function rewriteClaudeAgentModelFrontmatter(text: string): string {
	return text.replace(FRONTMATTER_BLOCK_PATTERN, (frontmatter) =>
		frontmatter.replace(
			/^([ \t]*model[ \t]*:[ \t]*)(?:(["'])(opus|sonnet|haiku)\2|(opus|sonnet|haiku))([ \t]*(?:#.*)?)$/gim,
			(_line, prefix, quote, quotedModel, bareModel, suffix) => {
				const model = CLAUDE_TO_CODEX_MODELS[(quotedModel ?? bareModel).toLowerCase()];
				return `${prefix}${quote ?? ""}${model}${quote ?? ""}${suffix}`;
			},
		),
	);
}

function rewriteClaudeAgentModels(root: string): void {
	for (const filePath of walkMdFiles(root)) {
		const before = readFileSync(filePath, "utf8");
		const after = rewriteClaudeAgentModelFrontmatter(before);
		if (after !== before) writeFileSync(filePath, after);
	}
}

function containsClaudeAgentModels(root: string): boolean {
	for (const filePath of walkMdFiles(root)) {
		const text = readFileSync(filePath, "utf8");
		if (rewriteClaudeAgentModelFrontmatter(text) !== text) return true;
	}
	return false;
}

function reportInvalidSkillFrontmatter(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const invalid: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillFile = join(dir, entry.name, "SKILL.md");
		if (!existsSync(skillFile)) continue;
		if (!hasYamlFrontmatter(readFileSync(skillFile, "utf8"))) invalid.push(skillFile);
	}
	return invalid;
}

function containsStaleScratchRefs(dir: string, env: NodeJS.ProcessEnv): boolean {
	if (!existsSync(dir)) return false;
	const walk = (d: string): boolean => {
		for (const entry of readdirSync(d, { withFileTypes: true })) {
			const full = join(d, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (walk(full)) return true;
				continue;
			}
			if (!entry.isFile()) continue;
			const buf = readFileSync(full);
			if (buf.includes(0)) continue;
			const text = buf.toString("utf8");
			if (rewriteScratchPaths(text, env) !== text) return true;
		}
		return false;
	};
	return walk(dir);
}

function translateClaudeStatusLine(claudeSettingsPath: string): string {
	if (existsSync(claudeSettingsPath)) {
		try {
			const data = JSON.parse(readFileSync(claudeSettingsPath, "utf8")) as { statusLine?: { command?: unknown } };
			const command = data.statusLine?.command;
			if (typeof command === "string" && CLAUDE_STATUSLINE_PATTERN.test(command)) return STATUS_LINE;
		} catch {
			return STATUS_LINE;
		}
	}
	return STATUS_LINE;
}

function renderStatusConfig(text: string, statusLine: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let inRoot = true;
	let inTui = false;
	let sawTui = false;
	let sawStatus = false;
	let sawTitle = false;

	const closeTui = (): void => {
		if (!inTui) return;
		if (!sawStatus) out.push(statusLine);
		if (!sawTitle) out.push(TERMINAL_TITLE);
		inTui = false;
	};

	for (const line of lines) {
		if (/^\[/.test(line)) {
			closeTui();
			inRoot = false;
			if (line === "[tui]") {
				sawTui = true;
				inTui = true;
				sawStatus = false;
				sawTitle = false;
				out.push(line);
				continue;
			}
		}
		if (inRoot && /^\s*status_line\s*=/.test(line)) continue;
		if (inRoot && /^\s*status_line_use_colors\s*=/.test(line)) continue;
		if (inRoot && /^\s*terminal_title\s*=/.test(line)) continue;
		if (inTui && /^\s*status_line\s*=/.test(line)) {
			out.push(statusLine);
			sawStatus = true;
			continue;
		}
		if (inTui && /^\s*status_line_use_colors\s*=/.test(line)) continue;
		if (inTui && /^\s*terminal_title\s*=/.test(line)) {
			out.push(TERMINAL_TITLE);
			sawTitle = true;
			continue;
		}
		out.push(line);
	}
	closeTui();
	if (!sawTui) out.push("", "[tui]", statusLine, TERMINAL_TITLE);
	return out.join("\n");
}

function renderContext7Mcp(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let inContext7 = false;
	let sawContext7 = false;
	let buffer: string[] = [];

	const closeContext7 = (): void => {
		if (!inContext7) return;
		const sawUrl = buffer.some((line) => /^\s*url\s*=/.test(line));
		const sawEnvLine = buffer.some((line) => /^\s*env_vars\s*=/.test(line));
		const sawBearerLine = buffer.some((line) => /^\s*bearer_token_env_var\s*=/.test(line));
		for (const line of buffer) {
			if (sawUrl && /^\s*env_vars\s*=/.test(line)) continue;
			if (sawUrl && /^\s*bearer_token_env_var\s*=/.test(line)) {
				out.push(CONTEXT7_BEARER);
				continue;
			}
			if (!sawUrl && /^\s*args\s*=/.test(line) && line.includes("@upstash/context7-mcp") && line.includes("--api-key")) {
				out.push(CONTEXT7_ARGS);
				continue;
			}
			out.push(line);
		}
		if (sawUrl && !sawBearerLine) out.push(CONTEXT7_BEARER);
		if (!sawUrl && !sawEnvLine) out.push(CONTEXT7_ENV);
		inContext7 = false;
		buffer = [];
	};

	for (const line of lines) {
		if (/^\[/.test(line) && line !== "[mcp_servers.context7]") closeContext7();
		if (line === "[mcp_servers.context7]") {
			sawContext7 = true;
			inContext7 = true;
			buffer = [];
			out.push(line);
			continue;
		}
		if (inContext7) {
			buffer.push(line);
			continue;
		}
		out.push(line);
	}
	closeContext7();
	if (!sawContext7) out.push("", "[mcp_servers.context7]", 'command = "npx"', CONTEXT7_ARGS, CONTEXT7_ENV);
	return out.join("\n");
}

function renderConfig(text: string, statusLine: string): string {
	return renderContext7Mcp(renderStatusConfig(text, statusLine));
}

interface HookEntry {
	type: string;
	command: string;
}
interface HookGroup {
	matcher: string;
	hooks: HookEntry[];
}
interface HooksFile {
	hooks: { PreToolUse?: HookGroup[]; PostToolUse?: HookGroup[] };
}

function isManagedHook(command: string, hooksRoot: string | undefined): boolean {
	if (command === "rtk hook claude") return true;
	return !!hooksRoot && command.startsWith(`${hooksRoot}/`);
}

function unmanagedGroups(groups: HookGroup[], hooksRoot: string | undefined): HookGroup[] {
	return groups
		.map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !isManagedHook(hook.command, hooksRoot)) }))
		.filter((group) => group.hooks.length > 0);
}

function claudeGroups(
	sourceGroups: HookGroup[],
	event: "PreToolUse" | "PostToolUse",
	hooksRoot: string | undefined,
	rtkHook: string | undefined,
): HookGroup[] {
	return sourceGroups
		.map((group) => ({
			...group,
			hooks: group.hooks
				.filter((hook) => isManagedHook(hook.command, hooksRoot))
				.map((hook) => (hook.command === "rtk hook claude" && rtkHook ? { ...hook, command: rtkHook } : hook)),
		}))
		.map((group) =>
			event === "PostToolUse" && group.matcher === "Edit|Write|MultiEdit" ? { ...group, matcher: "apply_patch" } : group,
		)
		.filter((group) => group.hooks.length > 0);
}

function readJsonFile<T>(path: string, fallback: T): T {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function renderHooks(p: Paths): HooksFile {
	const existing = readJsonFile<HooksFile>(p.codexHooks, { hooks: {} });
	const claudeSettings = readJsonFile<{ hooks?: { PreToolUse?: HookGroup[]; PostToolUse?: HookGroup[] } }>(
		p.claudeSettings,
		{},
	);
	const pre = [
		...unmanagedGroups(existing.hooks.PreToolUse ?? [], p.hooksRoot),
		...claudeGroups(claudeSettings.hooks?.PreToolUse ?? [], "PreToolUse", p.hooksRoot, p.rtkHook),
	];
	const post = [
		...unmanagedGroups(existing.hooks.PostToolUse ?? [], p.hooksRoot),
		...claudeGroups(claudeSettings.hooks?.PostToolUse ?? [], "PostToolUse", p.hooksRoot, p.rtkHook),
	];
	return { hooks: { PreToolUse: pre, PostToolUse: post } };
}

function normalizeHooks(hooks: HooksFile): unknown {
	return JSON.parse(JSON.stringify(hooks));
}

function mergedSkills(ctx: SyncContext) {
	const pluginRoot = resolvePluginSkillsRoot(ctx);
	const localRoot = resolveClaudeSkillsRoot(ctx);
	return mergeSkillSources(pluginRoot, existsSync(localRoot) ? localRoot : null);
}

function mergedAgents(ctx: SyncContext) {
	const pluginRoot = resolvePluginAgentsRoot(ctx);
	const localRoot = resolveClaudeAgentsRoot(ctx);
	return mergeAgentSources(pluginRoot, existsSync(localRoot) ? localRoot : null);
}

function importClaudeAgents(ctx: SyncContext, p: Paths, report: SyncReport): void {
	const { sources, shadowed } = mergedAgents(ctx);
	for (const name of shadowed) {
		report.warn(`plugin agent '${name}' shadows a local copy under the Claude agents directory; local copy left untouched`);
	}
	mkdirSync(p.codexAgentsDir, { recursive: true });
	for (const source of sources) {
		writeFileSync(join(p.codexAgentsDir, `${source.name}.md`), readFileSync(source.dir));
	}
	rewriteClaudeAgentModels(p.codexAgentsDir);
	rewriteTreeScratchPaths(p.codexAgentsDir, ctx.env);
	const count = readdirSync(p.codexAgentsDir, { withFileTypes: true }).filter(
		(entry) => entry.isFile() && entry.name.endsWith(".md"),
	).length;
	report.info(`imported Claude subagents into Codex: ${p.codexAgentsDir} (${count} agent file(s))`);
}

function importClaudeSkills(ctx: SyncContext, p: Paths, report: SyncReport): void {
	const { sources, shadowed } = mergedSkills(ctx);
	for (const name of shadowed) {
		report.warn(`plugin skill '${name}' shadows a local copy under the Claude skills directory; local copy left untouched`);
	}
	mkdirSync(p.codexSkillsDir, { recursive: true });

	const imported: string[] = [];
	const handled = new Set<string>();
	let pruned = 0;
	for (const source of sources) {
		if (source.name === "claude-sync" || source.name === "codex-sync") continue;
		const target = join(p.codexSkillsDir, source.name);
		const sharedSkill = join(p.agentsHome, "skills", source.name, "SKILL.md");
		if (existsSync(sharedSkill)) {
			handled.add(source.name);
			if (existsSync(target) && !isSymlink(target)) {
				rmSync(target, { recursive: true, force: true });
				pruned++;
				report.info(`pruned duplicate of ${join(p.agentsHome, "skills", source.name)}: ${target}`);
			}
			continue;
		}
		imported.push(source.name);
		const tmp = mkdtempSync(join(p.codexSkillsDir, `.${source.name}.`));
		copyTree(source.dir, tmp);
		ensureSkillFrontmatter(source.name, tmp);
		shortenSkillDescription(tmp);
		rewriteTreeScratchPaths(tmp, ctx.env);
		hideNonCodexSyncSkill(source.name, tmp);
		if (existsSync(target) || isSymlink(target)) rmSync(target, { recursive: true, force: true });
		renameSync(tmp, target);
	}

	const { pruned: prunedByManifest } = pruneStale(p.codexSkillsDir, "", p.importManifest, imported);
	for (const name of prunedByManifest) {
		if (handled.has(name)) continue;
		pruned++;
		report.info(`pruned stale skill: ${name}`);
	}
	report.info(`imported ${imported.length} Claude skill(s) into Codex: ${p.codexSkillsDir} (${pruned} pruned)`);
}

function installSkill(ctx: SyncContext, p: Paths, report: SyncReport): void {
	const pluginRoot = resolvePluginSkillsRoot(ctx);
	if (!pluginRoot) {
		report.warn("dg plugin skills root not found; skipping the codex-sync skill symlink");
		return;
	}
	const source = join(pluginRoot, "codex-sync");
	if (!existsSync(source)) {
		report.warn(`dg plugin has no codex-sync skill at ${source}; skipping the codex-sync skill symlink`);
		return;
	}
	const target = join(p.codexSkillsDir, "codex-sync");
	mkdirSync(p.codexSkillsDir, { recursive: true });
	if (existsSync(target) || isSymlink(target)) {
		try {
			if (realpathSync(target) === realpathSync(source)) {
				report.info(`codex-sync skill link already current: ${target}`);
				return;
			}
		} catch {}
		rmSync(target, { recursive: true, force: true });
	}
	symlinkSync(source, target);
	report.info(`installed Codex-native skill: ${target} -> ${source}`);
}

function existsLabel(path: string): "yes" | "no" {
	return existsSync(path) ? "yes" : "no";
}

async function probeOrDryRun(ctx: SyncContext, dry: boolean): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	const { sources: skillSources } = mergedSkills(ctx);
	const { sources: agentSources } = mergedAgents(ctx);

	report.info("== dg-skills sync codex probe ==");
	report.info(`Claude source: ${p.claudeHome} (${existsLabel(p.claudeHome)})`);
	report.info(`Claude settings: ${p.claudeSettings} (${existsLabel(p.claudeSettings)})`);
	report.info(`Codex config: ${p.codexConfig} (${existsLabel(p.codexConfig)})`);
	report.info(`Codex hooks: ${p.codexHooks} (${existsLabel(p.codexHooks)})`);
	report.info(`agents: ${agentSources.length} merged source(s)`);
	report.info(`skills: ${skillSources.length} merged source(s)`);
	report.info(`shared skills (agentsHome): ${join(p.agentsHome, "skills")} (${existsLabel(join(p.agentsHome, "skills"))})`);

	const pluginRoot = resolvePluginSkillsRoot(ctx);
	report.info(`codex-sync skill source: ${pluginRoot ? join(pluginRoot, "codex-sync") : "(dg plugin root not found)"}`);

	if (existsSync(p.codexConfig)) {
		const text = readFileSync(p.codexConfig, "utf8");
		const statusLine = text.split("\n").find((line) => /^\s*status_line\s*=/.test(line));
		report.info(`status line: ${statusLine ?? "not configured"}`);
	}
	report.info(`scratch dir: ${scratchRoot(ctx.env)}`);

	if (!existsSync(p.codexConfig) || !existsSync(p.codexHooks)) {
		report.warn("Codex import artifacts are incomplete; apply will bootstrap missing config/hooks files.");
	}
	if (!p.hooksRoot) {
		report.info("hooks root not configured (set HOOKS_ROOT); hook translation will be skipped");
	}

	if (dry) {
		report.info("");
		report.info("Planned operations:");
		report.info(`  - translate Claude statusLine.command into [tui].${translateClaudeStatusLine(p.claudeSettings)}`);
		report.info(`  - set [tui].${TERMINAL_TITLE}`);
		report.info(`  - ensure Context7 MCP uses ${CONTEXT7_ENV}`);
		if (hooksAvailable(p)) {
			report.info(`  - reconcile Claude-compatible PreToolUse and PostToolUse hooks in ${p.codexHooks}`);
		} else {
			report.info("  - skip hook reconciliation: HOOKS_ROOT is not configured (or its hook files are missing/non-executable)");
		}
		report.info(`  - import ${agentSources.length} Claude subagent(s) into ${p.codexAgentsDir}`);
		report.info("  - translate agent model tiers: opus -> gpt-5.6-sol, sonnet -> gpt-5.6-terra, haiku -> gpt-5.6-luna");
		report.info(`  - import ${skillSources.length} Claude skill(s) into ${p.codexSkillsDir}`);
		report.info("  - prune imported skills removed from Claude or already loaded from the shared skills directory");
		report.info("  - add missing YAML frontmatter to imported Claude SKILL.md files");
		report.info("  - shorten imported skill descriptions to fit the Codex skills context budget");
		report.info("  - hide non-Codex sync target skills while preserving their CLI commands");
		report.info("  - rewrite imported skill and agent scratch paths");
		report.info(`  - link ${join(p.codexSkillsDir, "codex-sync")} -> the dg plugin's codex-sync skill`);
	}
	return report;
}

async function apply(ctx: SyncContext): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	mkdirSync(p.codexHome, { recursive: true });

	if (!existsSync(p.codexConfig)) {
		mkdirSync(dirname(p.codexConfig), { recursive: true });
		writeFileSync(p.codexConfig, "");
		report.info(`created missing Codex config: ${p.codexConfig}`);
	}
	if (!existsSync(p.codexHooks)) {
		mkdirSync(dirname(p.codexHooks), { recursive: true });
		writeFileSync(p.codexHooks, `${JSON.stringify({ hooks: { PreToolUse: [], PostToolUse: [] } }, null, 2)}\n`);
		report.info(`created missing Codex hooks file: ${p.codexHooks}`);
	}

	const statusLine = translateClaudeStatusLine(p.claudeSettings);
	const config = readFileSync(p.codexConfig, "utf8");
	writeFileSync(p.codexConfig, renderConfig(config, statusLine));
	report.info(`updated native Codex config parity: ${p.codexConfig}`);

	if (hooksAvailable(p)) {
		const hooks = renderHooks(p);
		writeFileSync(p.codexHooks, `${JSON.stringify(hooks, null, 2)}\n`);
		report.info(`reconciled Claude-compatible hooks for Codex: ${p.codexHooks}`);
		report.info("review changed hook definitions once with /hooks");
	} else {
		report.warn("hooks root not configured (set HOOKS_ROOT); skipping Claude-to-Codex hook translation");
	}

	importClaudeAgents(ctx, p, report);
	importClaudeSkills(ctx, p, report);
	installSkill(ctx, p, report);

	const verifyReport = await verify(ctx);
	report.merge(verifyReport);
	return report;
}

async function verify(ctx: SyncContext): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	const expectedStatusLine = translateClaudeStatusLine(p.claudeSettings);

	if (!existsSync(p.codexConfig)) {
		report.fail(`missing Codex config: ${p.codexConfig}`);
	} else {
		const text = readFileSync(p.codexConfig, "utf8");
		const lines = text.split("\n");
		let inTui = false;
		let inRoot = true;
		let statusOk = false;
		let titleOk = false;
		let badRoot = false;
		for (const line of lines) {
			if (/^\[/.test(line)) {
				inTui = line === "[tui]";
				inRoot = false;
				continue;
			}
			if (inRoot && /^\s*(status_line|status_line_use_colors|terminal_title)\s*=/.test(line)) badRoot = true;
			if (inTui && line === expectedStatusLine) statusOk = true;
			if (inTui && line === TERMINAL_TITLE) titleOk = true;
		}
		if (!statusOk || !titleOk || badRoot) {
			report.fail("Claude status line has not been translated to Codex native [tui].status_line");
		}

		let inContext7 = false;
		let sawContext7 = false;
		let http = false;
		let envOk = false;
		let bearerOk = false;
		let badSecret = false;
		for (const line of lines) {
			if (line === "[mcp_servers.context7]") {
				inContext7 = true;
				sawContext7 = true;
				continue;
			}
			if (/^\[/.test(line)) inContext7 = false;
			if (inContext7 && /^\s*url\s*=/.test(line)) http = true;
			if (inContext7 && line === CONTEXT7_ENV) envOk = true;
			if (inContext7 && line === CONTEXT7_BEARER) bearerOk = true;
			if (inContext7 && /ctx7sk-|--api-key/.test(line)) badSecret = true;
		}
		const contextOk = sawContext7 && !badSecret && (http ? bearerOk : envOk);
		if (!contextOk) {
			report.fail("Context7 MCP does not read CONTEXT7_API_KEY through its transport-specific env setting");
		}
		if (/ctx7sk-|--api-key/.test(text)) {
			report.fail("Context7 MCP config still contains an inline API-key shape");
		}
	}

	if (p.hooksRoot) {
		for (const hook of [p.rtkHook, p.applyPatchInputsHook]) {
			if (hook && !isExecutable(hook)) report.fail(`required hook helper is not executable: ${hook}`);
		}
		const expected = renderHooks(p);
		const actual = readJsonFile<HooksFile>(p.codexHooks, { hooks: {} });
		if (!existsSync(p.codexHooks) || JSON.stringify(normalizeHooks(expected)) !== JSON.stringify(normalizeHooks(actual))) {
			report.fail("Codex hooks differ from Claude-compatible hooks");
		}
	} else {
		report.info("hooks root not configured (set HOOKS_ROOT); skipped Claude-to-Codex hook verification");
	}

	if (!existsSync(p.codexSkillsDir)) {
		report.fail(`Codex skills directory is missing: ${p.codexSkillsDir}`);
	} else {
		const invalid = reportInvalidSkillFrontmatter(p.codexSkillsDir);
		if (invalid.length > 0) {
			for (const file of invalid) report.warn(`${file} is missing YAML frontmatter delimited by ---`);
			report.fail("Codex skills include invalid SKILL.md frontmatter");
		} else if (containsStaleScratchRefs(p.codexSkillsDir, ctx.env)) {
			report.fail("Codex skills still mention tool-specific scratch roots; expected the configured scratch directory");
		}
	}

	if (!existsSync(p.codexAgentsDir)) {
		report.fail(`Codex agents directory is missing: ${p.codexAgentsDir}`);
	} else {
		const mdFiles = readdirSync(p.codexAgentsDir, { withFileTypes: true }).filter(
			(entry) => entry.isFile() && entry.name.endsWith(".md"),
		);
		if (mdFiles.length === 0) {
			report.fail("Codex subagents are missing Markdown agent files");
		} else if (containsStaleScratchRefs(p.codexAgentsDir, ctx.env)) {
			report.fail("Codex subagents still mention tool-specific scratch roots; expected the configured scratch directory");
		} else if (containsClaudeAgentModels(p.codexAgentsDir)) {
			report.fail("Codex subagents still use Claude model tiers; expected GPT-5.6 Sol/Terra/Luna");
		}
	}

	const pluginRoot = resolvePluginSkillsRoot(ctx);
	const target = join(p.codexSkillsDir, "codex-sync");
	if (!pluginRoot) {
		report.warn("dg plugin skills root not found; skipped the codex-sync skill link check");
	} else {
		const expectedSkillSource = join(pluginRoot, "codex-sync");
		if (!existsSync(expectedSkillSource)) {
			report.warn(`dg plugin has no codex-sync skill at ${expectedSkillSource}; skipped the codex-sync skill link check`);
		} else {
			let actualTarget: string | undefined;
			try {
				actualTarget = realpathSync(target);
			} catch {
				actualTarget = undefined;
			}
			if (actualTarget !== realpathSync(expectedSkillSource)) {
				report.fail(`Codex sync skill is not linked to this source: ${target}`);
			}
		}
	}

	if (report.ok) {
		report.info("Verification OK");
		report.info("Hook trust is intentionally reviewed separately with /hooks");
	} else {
		report.info(`Verification failed with ${report.warnings.length} issue(s)`);
	}
	return report;
}

export const codexTarget: SyncTarget<CodexFlags> = {
	id: "codex",
	usage: "sync codex <probe|dry-run|apply|verify>",
	parseFlags(argv) {
		if (argv.length > 0) return { error: `unknown option: ${argv[0]}` };
		return { flags: {} };
	},
	probe: (ctx) => probeOrDryRun(ctx, false),
	dryRun: (ctx) => probeOrDryRun(ctx, true),
	apply: (ctx) => apply(ctx),
	verify: (ctx) => verify(ctx),
};
