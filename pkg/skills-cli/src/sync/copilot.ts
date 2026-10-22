/** `dg-skills sync copilot` — syncs Claude-authored assets into `~/.copilot`. */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchRoot, stateRoot } from "@dg/common/node";
import { transformAgentText } from "./agent-transform";
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
import { checkSecretWall } from "./secret-wall";
import { stripJsonc } from "./strip-jsonc";
import { copyTree, isSymlink, readlinkSafe, rewriteTreeScratchPaths } from "./tree-copy";
import type { SyncContext, SyncTarget } from "./types";
import { SyncReport } from "./types";

export interface CopilotFlags {
	copySkills: boolean;
}

function paths(ctx: SyncContext) {
	const home = ctx.home;
	const env = ctx.env;
	const copilotHome = env.COPILOT_HOME || join(home, ".copilot");
	const claudeHome = env.CLAUDE_HOME || join(home, ".claude");
	const hooksDir = join(copilotHome, "hooks");
	return {
		copilotHome,
		claudeHome,
		config: env.COPILOT_CONFIG || join(copilotHome, "config.json"),
		mcpConfig: env.COPILOT_MCP_CONFIG || join(copilotHome, "mcp-config.json"),
		skills: env.COPILOT_SKILLS || join(copilotHome, "skills"),
		agents: env.COPILOT_AGENTS || join(copilotHome, "agents"),
		hooksDir,
		hooksFile: join(hooksDir, "hooks.json"),
		homeInstructions: env.COPILOT_HOME_INSTRUCTIONS || join(copilotHome, "copilot-instructions.md"),
		claudeInstructionsSrc: env.CLAUDE_INSTRUCTIONS_SRC || join(claudeHome, "CLAUDE.md"),
		claudeJson: env.CLAUDE_JSON || join(home, ".claude.json"),
		opencodeConfig: env.OPENCODE_CONFIG || join(home, ".config", "opencode", "opencode.json"),
		agentsManifest: join(copilotHome, ".dg-sync-agents"),
		skillsManifest: join(copilotHome, ".dg-sync-skills"),
		statusline: env.COPILOT_STATUSLINE_SCRIPT,
		preToolHook: env.COPILOT_PRETOOLUSE_HOOK,
		postToolHook: env.COPILOT_POSTTOOLUSE_HOOK,
	};
}

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(stripJsonc(readFileSync(path, "utf8")).body);
	} catch {
		return undefined;
	}
}

interface McpServer {
	type: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	tools?: unknown;
}

function claudeMcpServers(claudeJsonPath: string): Record<string, McpServer> {
	const data = readJson(claudeJsonPath) as { mcpServers?: Record<string, Record<string, unknown>> } | undefined;
	const out: Record<string, McpServer> = {};
	for (const [name, raw] of Object.entries(data?.mcpServers ?? {})) {
		if (raw.enabled === false) continue;
		const type = (raw.type as string | undefined) ?? "stdio";
		if ((type === "stdio" || type === "local") && typeof raw.command === "string") {
			out[name] = {
				type: "local",
				command: raw.command,
				args: Array.isArray(raw.args) ? (raw.args as string[]) : [],
				env: (raw.env as Record<string, string>) ?? {},
				...(raw.cwd ? { cwd: raw.cwd as string } : {}),
				...(raw.tools ? { tools: raw.tools } : {}),
			};
		} else if ((type === "http" || type === "sse") && typeof raw.url === "string") {
			out[name] = {
				type: "http",
				url: raw.url,
				...(raw.headers ? { headers: raw.headers as Record<string, string> } : {}),
				...(raw.tools ? { tools: raw.tools } : {}),
			};
		}
	}
	return out;
}

function opencodeMcpServers(opencodeConfigPath: string): Record<string, McpServer> {
	const data = readJson(opencodeConfigPath) as { mcp?: Record<string, Record<string, unknown>> } | undefined;
	const out: Record<string, McpServer> = {};
	for (const [name, raw] of Object.entries(data?.mcp ?? {})) {
		if (raw.enabled === false) continue;
		const type = (raw.type as string | undefined) ?? "local";
		if (type === "local" && Array.isArray(raw.command) && raw.command.length > 0) {
			const [command, ...args] = raw.command as string[];
			out[name] = { type: "local", command, args, env: (raw.env as Record<string, string>) ?? {} };
		} else if ((type === "remote" || type === "http") && typeof raw.url === "string") {
			out[name] = { type: "http", url: raw.url };
		}
	}
	return out;
}

function stripHeadful(servers: Record<string, McpServer>): Record<string, McpServer> {
	const playwright = servers.playwright;
	if (!playwright || !Array.isArray(playwright.args)) return servers;
	return { ...servers, playwright: { ...playwright, args: playwright.args.filter((a) => a !== "--headful") } };
}

function buildSkillsAndAgents(ctx: SyncContext) {
	const pluginSkills = resolvePluginSkillsRoot(ctx);
	const localSkills = resolveClaudeSkillsRoot(ctx);
	const skillMerge = mergeSkillSources(pluginSkills, existsSync(localSkills) ? localSkills : null);

	const pluginAgents = resolvePluginAgentsRoot(ctx);
	const localAgents = resolveClaudeAgentsRoot(ctx);
	const agentMerge = mergeAgentSources(pluginAgents, existsSync(localAgents) ? localAgents : null);

	const pluginContributesSkills = skillMerge.sources.some((s) => s.origin === "plugin");
	const singleSkillsRoot =
		!pluginContributesSkills && existsSync(localSkills) && skillMerge.sources.length > 0 ? localSkills : null;

	return { skillMerge, agentMerge, singleSkillsRoot };
}

function applySkills(ctx: SyncContext, flags: CopilotFlags, report: SyncReport): string {
	const p = paths(ctx);
	const { skillMerge, singleSkillsRoot } = buildSkillsAndAgents(ctx);
	for (const name of skillMerge.shadowed) {
		report.warn(`plugin skill '${name}' shadows a local copy under the Claude skills directory; local copy left untouched`);
	}

	const useCopy = flags.copySkills || singleSkillsRoot === null;
	if (!useCopy) {
		const target = singleSkillsRoot as string;
		if (existsSync(p.skills) || isSymlink(p.skills)) {
			if (isSymlink(p.skills) && readlinkSafe(p.skills) === target) {
				report.info(`skills symlink already up to date: ${p.skills} -> ${target}`);
				return target;
			}
			rmSync(p.skills, { recursive: true, force: true });
		}
		mkdirSync(dirname(p.skills), { recursive: true });
		symlinkSync(target, p.skills);
		report.info(`linked skills: ${p.skills} -> ${target}`);
		return target;
	}

	if (isSymlink(p.skills)) rmSync(p.skills, { force: true });
	mkdirSync(p.skills, { recursive: true });
	const kept: string[] = [];
	for (const source of skillMerge.sources) {
		const destDir = join(p.skills, source.name);
		copyTree(source.dir, destDir);
		rewriteTreeScratchPaths(destDir, ctx.env);
		kept.push(source.name);
	}
	const { pruned } = pruneStale(p.skills, "", p.skillsManifest, kept);
	for (const name of pruned) report.info(`pruned stale skill: ${name}`);
	if (kept.length === 0 && pruned.length === 0) {
		report.warn(`no skills found to sync (checked the dg plugin tree and the Claude skills directory)`);
	} else {
		report.info(`copied ${kept.length} skill(s) into ${p.skills} (with scratch-path rewrites)`);
	}
	return p.skills;
}

function applyAgents(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	const { agentMerge } = buildSkillsAndAgents(ctx);
	for (const name of agentMerge.shadowed) {
		report.warn(`plugin agent '${name}' shadows a local copy under the Claude agents directory; local copy left untouched`);
	}
	mkdirSync(p.agents, { recursive: true });
	const kept: string[] = [];
	let failures = 0;
	for (const source of agentMerge.sources) {
		const text = readFileSync(source.dir, "utf8");
		const result = transformAgentText(text, "copilot", source.name);
		if (!result.ok) {
			report.warn(`agent failed: ${source.name}: ${result.message}`);
			failures++;
			continue;
		}
		writeFileSync(join(p.agents, result.filename), result.content, "utf8");
		kept.push(source.name);
	}
	const { pruned } = pruneStale(p.agents, ".agent.md", p.agentsManifest, kept);
	for (const name of pruned) report.info(`pruned stale agent: ${name}`);
	let message = `transformed ${kept.length} agent(s) into ${p.agents}`;
	if (failures > 0) message += ` (${failures} failed)`;
	report.info(message);
}

function applyHooks(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	mkdirSync(p.hooksDir, { recursive: true });
	const preToolUse: Array<{ type: string; bash: string }> = [];
	const postToolUse: Array<{ type: string; bash: string }> = [];
	if (p.preToolHook && existsSync(p.preToolHook)) preToolUse.push({ type: "command", bash: p.preToolHook });
	else if (p.preToolHook) report.warn(`configured pre-tool-use hook not found: ${p.preToolHook}`);
	if (p.postToolHook && existsSync(p.postToolHook)) postToolUse.push({ type: "command", bash: p.postToolHook });
	else if (p.postToolHook) report.warn(`configured post-tool-use hook not found: ${p.postToolHook}`);
	const hooks = { version: 1, hooks: { preToolUse, postToolUse } };
	writeFileSync(p.hooksFile, `${JSON.stringify(hooks, null, 2)}\n`);
	report.info(`wrote hooks config: ${p.hooksFile}`);
}

function applyHomeInstructions(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	if (!existsSync(p.claudeInstructionsSrc)) return;
	const raw = readFileSync(p.claudeInstructionsSrc, "utf8");
	const content = `<!-- Generated by dg-skills sync copilot from ${p.claudeInstructionsSrc} -->\n\n${rewriteScratchPaths(raw, ctx.env)}`;
	writeFileSync(p.homeInstructions, content);
	report.info(`generated Copilot home instructions: ${p.homeInstructions}`);
}

function applyMcpConfig(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	const existing = (readJson(p.mcpConfig) as { mcpServers?: Record<string, McpServer> } | undefined)?.mcpServers ?? {};
	const incoming = { ...claudeMcpServers(p.claudeJson), ...opencodeMcpServers(p.opencodeConfig) };
	const merged = stripHeadful({ ...incoming, ...existing });
	writeFileSync(p.mcpConfig, `${JSON.stringify({ mcpServers: merged }, null, 2)}\n`);
	report.info(`merged MCP config into: ${p.mcpConfig}`);
}

function applyCopilotConfig(ctx: SyncContext, flags: CopilotFlags, skillsDir: string, report: SyncReport): void {
	const p = paths(ctx);
	const raw = existsSync(p.config) ? readFileSync(p.config, "utf8") : "{}";
	const { header, body } = stripJsonc(raw);
	let json: Record<string, unknown>;
	try {
		json = JSON.parse(body || "{}");
	} catch {
		json = {};
	}

	const statusLine = (json.statusLine ?? json.status_line ?? { type: "command" }) as Record<string, unknown>;
	statusLine.type = "command";
	if (p.statusline && existsSync(p.statusline)) {
		statusLine.command = `bash ${p.statusline}`;
	} else if (p.statusline) {
		report.warn(`configured statusline script not found: ${p.statusline}`);
	}
	json.statusLine = statusLine;
	json.status_line = statusLine;

	const scratch = scratchRoot(ctx.env);
	const state = stateRoot(ctx.env, ctx.home);
	const trusted = new Set([...(asStringArray(json.trustedFolders) ?? asStringArray(json.trusted_folders) ?? []), scratch, state]);
	json.trustedFolders = [...trusted];
	json.trusted_folders = json.trustedFolders;

	const skillDirs = new Set([...(asStringArray(json.skillDirectories) ?? asStringArray(json.skill_directories) ?? []), skillsDir]);
	json.skillDirectories = [...skillDirs];
	json.skill_directories = json.skillDirectories;

	json.custom_agents = { ...(typeof json.custom_agents === "object" && json.custom_agents ? json.custom_agents : {}), default_local_only: true };

	const bodyOut = JSON.stringify(json, null, 2);
	writeFileSync(p.config, header ? `${header}\n${bodyOut}\n` : `${bodyOut}\n`);
	report.info(`updated Copilot config: ${p.config}`);
	void flags;
}

function asStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

async function probeOrDryRun(ctx: SyncContext, flags: CopilotFlags, dry: boolean): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	const { skillMerge, agentMerge } = buildSkillsAndAgents(ctx);
	report.info("== dg-skills sync copilot probe ==");
	report.info(`skills: ${skillMerge.sources.length} source(s) (${skillMerge.shadowed.length} shadowed by the plugin)`);
	report.info(`agents: ${agentMerge.sources.length} source(s) (${agentMerge.shadowed.length} shadowed by the plugin)`);
	report.info(`Copilot config: ${p.config}`);
	report.info(`Copilot mcp-config: ${p.mcpConfig}`);
	report.info(`Copilot hooks: ${p.hooksFile}`);
	report.info("");
	report.info("Compatibility matrix:");
	report.info("  skills    -> symlinkable (single source, default) or copy+rewrite (merged sources or --copy-skills)");
	report.info("  subagents -> copy+transform to *.agent.md");
	report.info("  hooks     -> copy+transform to hooks.json (version 1)");
	report.info("  mcp       -> merge+transform into mcpServers schema");
	report.info("  instructions -> copy+rewrite CLAUDE.md => copilot-instructions.md");
	report.info("  statusline-> configured external command adapter (unset by default)");
	if (dry) {
		report.info("");
		report.info("Planned operations (dry-run):");
		report.info(flags.copySkills || !existsSync(resolveClaudeSkillsRoot(ctx)) ? `  - Copy merged skills into ${p.skills}` : `  - Symlink ${p.skills} -> source (if safe)`);
		report.info(`  - Transform ${agentMerge.sources.length} agent(s) into ${p.agents}/*.agent.md`);
		report.info(`  - Write hooks config to ${p.hooksFile}`);
		report.info(`  - Merge MCP servers into ${p.mcpConfig}`);
		report.info(`  - Update ${p.config} with statusLine, skillDirectories, custom_agents, trustedFolders`);
	}
	return report;
}

async function apply(ctx: SyncContext, flags: CopilotFlags): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	mkdirSync(p.copilotHome, { recursive: true });
	if (!existsSync(p.config)) writeFileSync(p.config, "{}\n");
	if (!existsSync(p.mcpConfig)) writeFileSync(p.mcpConfig, JSON.stringify({ mcpServers: {} }) + "\n");

	const skillsDir = applySkills(ctx, flags, report);
	applyAgents(ctx, report);
	applyHooks(ctx, report);
	applyHomeInstructions(ctx, report);
	applyMcpConfig(ctx, report);
	applyCopilotConfig(ctx, flags, skillsDir, report);

	const verifyReport = await verify(ctx, flags);
	report.merge(verifyReport);
	return report;
}

async function verify(ctx: SyncContext, _flags: CopilotFlags): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);

	const secretHits = checkSecretWall([p.mcpConfig, p.config]);
	for (const hit of secretHits) report.fail(`secret-wall: secret literal detected in ${hit.path}`);

	if (!existsSync(p.config)) {
		report.fail(`invalid or missing Copilot config: ${p.config}`);
	} else {
		try {
			JSON.parse(stripJsonc(readFileSync(p.config, "utf8")).body);
		} catch {
			report.fail(`invalid or missing Copilot config: ${p.config}`);
		}
	}

	const mcp = readJson(p.mcpConfig) as { mcpServers?: unknown } | undefined;
	if (!mcp || typeof mcp.mcpServers !== "object") report.fail(`invalid or missing MCP config: ${p.mcpConfig}`);

	const hooks = readJson(p.hooksFile) as { version?: number; hooks?: unknown } | undefined;
	if (!hooks || hooks.version !== 1 || typeof hooks.hooks !== "object") report.fail(`invalid or missing hooks config: ${p.hooksFile}`);

	if (existsSync(p.claudeInstructionsSrc) && !existsSync(p.homeInstructions)) {
		report.fail(`missing converted Copilot instructions: ${p.homeInstructions}`);
	}

	const configJson = readJson(p.config) as Record<string, unknown> | undefined;
	const statusLineCommand = ((configJson?.statusLine as Record<string, unknown> | undefined)?.command ??
		(configJson?.status_line as Record<string, unknown> | undefined)?.command ??
		"") as string;
	if (p.statusline && !statusLineCommand.includes(p.statusline)) {
		report.fail(`statusLine is not wired to the configured statusline script`);
	}

	const scratch = scratchRoot(ctx.env);
	const state = stateRoot(ctx.env, ctx.home);
	const trustedFolders = asStringArray(configJson?.trustedFolders) ?? asStringArray(configJson?.trusted_folders) ?? [];
	for (const root of [scratch, state]) {
		if (!trustedFolders.includes(root)) report.fail(`${root} is not in trustedFolders`);
	}

	const playwrightArgs = (mcp?.mcpServers as Record<string, McpServer> | undefined)?.playwright?.args;
	if (Array.isArray(playwrightArgs) && playwrightArgs.includes("--headful")) {
		report.fail("playwright MCP args still include unsupported --headful flag");
	}

	if (report.ok) report.info("Verification OK");
	else report.info(`Verification failed with ${report.warnings.length} issue(s)`);
	return report;
}

export const copilotTarget: SyncTarget<CopilotFlags> = {
	id: "copilot",
	usage: "sync copilot <probe|dry-run|apply|verify> [--copy-skills]",
	parseFlags(argv) {
		let copySkills = false;
		for (const arg of argv) {
			if (arg === "--copy-skills") copySkills = true;
			else return { error: `unknown option: ${arg}` };
		}
		return { flags: { copySkills } };
	},
	probe: (ctx, flags) => probeOrDryRun(ctx, flags, false),
	dryRun: (ctx, flags) => probeOrDryRun(ctx, flags, true),
	apply,
	verify,
};
