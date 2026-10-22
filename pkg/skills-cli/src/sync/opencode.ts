/** `dg-skills sync opencode` — syncs Claude-authored assets into `~/.config/opencode`. */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCredentialClient, resolveDgPaths } from "@dg/common/node";
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
import { checkSecretWall } from "./secret-wall";
import { transformSkillText } from "./skill-transform";
import { copyTree } from "./tree-copy";
import type { SyncContext, SyncTarget } from "./types";
import { SyncReport } from "./types";

export interface OpencodeFlags {
	syncDtf: boolean;
}

function paths(ctx: SyncContext) {
	const configHome = ctx.env.CONFIG_HOME || join(ctx.home, ".config", "opencode");
	return {
		configHome,
		agentsDst: join(configHome, "agents"),
		skillsDst: join(configHome, "skills"),
		hooksDst: join(configHome, "hooks"),
		pluginsDst: join(configHome, "plugins"),
		opencodeConfig: join(configHome, "opencode.json"),
		agentsManifest: join(configHome, ".dg-sync-agents"),
		hooksManifest: join(configHome, ".dg-sync-hooks"),
		pluginsManifest: join(configHome, ".dg-sync-plugins"),
		hooksSrc: ctx.env.OPENCODE_HOOKS_SRC,
		pluginsSrc: ctx.env.OPENCODE_PLUGINS_SRC,
	};
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

function readJson(path: string): unknown {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function envRefsInMcpConfig(opencodeConfigPath: string): string[] {
	const data = readJson(opencodeConfigPath) as { mcp?: Record<string, { env?: Record<string, string> }> } | undefined;
	const refs = new Set<string>();
	for (const server of Object.values(data?.mcp ?? {})) {
		for (const value of Object.values(server.env ?? {})) {
			for (const match of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) refs.add(match[1]);
		}
	}
	return [...refs].sort();
}

function credentialNameFor(envVar: string): string {
	return `sync/${envVar.toLowerCase().replaceAll("_", "-")}`;
}

async function checkRequiredSecrets(ctx: SyncContext, report: SyncReport): Promise<boolean> {
	const p = paths(ctx);
	const refs = envRefsInMcpConfig(p.opencodeConfig);
	if (refs.length === 0) return true;

	const client = createCredentialClient({ paths: resolveDgPaths({ homeDir: ctx.home, env: ctx.env }) });
	const missing: string[] = [];
	try {
		for (const ref of refs) {
			try {
				const record = await client.get(credentialNameFor(ref));
				if (record === undefined) missing.push(ref);
			} catch {
				missing.push(ref);
			}
		}
	} finally {
		client.close();
	}

	for (const ref of missing) {
		report.fail(`missing secret: run \`~/.dg/bin/dg-skills credentials set ${credentialNameFor(ref)}\` for ${ref}`);
	}
	return missing.length === 0;
}

function syncSkills(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	const { sources, shadowed } = mergedSkills(ctx);
	for (const name of shadowed) {
		report.warn(`plugin skill '${name}' shadows a local copy under the Claude skills directory; local copy left untouched`);
	}
	mkdirSync(p.skillsDst, { recursive: true });
	let count = 0;
	for (const source of sources) {
		const destDir = join(p.skillsDst, source.name);
		copyTree(source.dir, destDir);
		const skillFile = join(destDir, "SKILL.md");
		const result = transformSkillText(readFileSync(skillFile, "utf8"), ctx.env);
		if (!result.ok) {
			report.warn(`skill frontmatter invalid: ${source.name} (skipped)`);
			continue;
		}
		writeFileSync(skillFile, result.content);
		count++;
	}
	report.info(`skills: ${count}`);
}

function syncAgents(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	const { sources, shadowed } = mergedAgents(ctx);
	for (const name of shadowed) {
		report.warn(`plugin agent '${name}' shadows a local copy under the Claude agents directory; local copy left untouched`);
	}
	mkdirSync(p.agentsDst, { recursive: true });
	const kept: string[] = [];
	let failures = 0;
	for (const source of sources) {
		const text = readFileSync(source.dir, "utf8");
		const result = transformAgentText(text, "opencode", source.name);
		if (!result.ok) {
			report.warn(`agent failed: ${source.name}: ${result.message}`);
			failures++;
			continue;
		}
		writeFileSync(join(p.agentsDst, result.filename), result.content, "utf8");
		kept.push(source.name);
	}
	const { pruned } = pruneStale(p.agentsDst, ".md", p.agentsManifest, kept);
	let message = `agents: ${kept.length}`;
	if (pruned.length > 0) message += `, ${pruned.length} pruned`;
	if (failures > 0) message += `, ${failures} failed`;
	report.info(message);
}

function syncHooks(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	if (!p.hooksSrc || !existsSync(p.hooksSrc)) {
		report.warn("no hooks source configured (set OPENCODE_HOOKS_SRC); skipped");
		return;
	}
	mkdirSync(p.hooksDst, { recursive: true });
	const kept: string[] = [];
	for (const entry of readdirSync(p.hooksSrc, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		writeFileSync(join(p.hooksDst, entry.name), readFileSync(join(p.hooksSrc, entry.name)));
		if (entry.name !== "README.md") kept.push(entry.name);
	}
	const { pruned } = pruneStale(p.hooksDst, "", p.hooksManifest, kept);
	let message = `hooks: ${kept.length}`;
	if (pruned.length > 0) message += `, ${pruned.length} pruned`;
	report.info(message);
}

function syncPlugins(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	if (!p.pluginsSrc || !existsSync(p.pluginsSrc)) {
		report.warn("no plugins source configured (set OPENCODE_PLUGINS_SRC); skipped");
		return;
	}
	mkdirSync(p.pluginsDst, { recursive: true });
	const kept: string[] = [];
	for (const entry of readdirSync(p.pluginsSrc, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		copyTree(join(p.pluginsSrc, entry.name), join(p.pluginsDst, entry.name));
		kept.push(entry.name);
	}
	const { pruned } = pruneStale(p.pluginsDst, "", p.pluginsManifest, kept);
	let message = `plugins: ${kept.length}`;
	if (pruned.length > 0) message += `, ${pruned.length} pruned`;
	report.info(message);
}

const EXPECTED_PLUGINS = ["american-english-hook", "format-hook"];

function updateConfigPlugins(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	if (!existsSync(p.opencodeConfig)) {
		report.warn("no opencode.json");
		return;
	}
	const data = readJson(p.opencodeConfig) as { plugin?: string[] } & Record<string, unknown>;
	const current = Array.isArray(data.plugin) ? data.plugin : [];
	const merged = [...new Set([...EXPECTED_PLUGINS, ...current])];
	if (JSON.stringify(merged) === JSON.stringify(current)) {
		report.info("config: up-to-date");
		return;
	}
	writeFileSync(p.opencodeConfig, JSON.stringify({ ...data, plugin: merged }, null, 2) + "\n");
	report.info("config: plugins registered");
}

function verifyAgents(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	if (!existsSync(p.agentsDst)) return;
	for (const entry of readdirSync(p.agentsDst, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const text = readFileSync(join(p.agentsDst, entry.name), "utf8");
		if (!/^description\s*:/m.test(text.split("\n").slice(0, 10).join("\n"))) {
			report.fail(`agent invalid (missing description): ${entry.name}`);
		}
	}
}

function verifySkills(ctx: SyncContext, report: SyncReport): void {
	const p = paths(ctx);
	if (!existsSync(p.skillsDst)) return;
	for (const entry of readdirSync(p.skillsDst, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillFile = join(p.skillsDst, entry.name, "SKILL.md");
		if (!existsSync(skillFile)) continue;
		const result = transformSkillText(readFileSync(skillFile, "utf8"), ctx.env);
		if (!result.ok) report.fail(`skill invalid: ${entry.name}: ${result.message}`);
	}
}

async function probeOrDryRun(ctx: SyncContext, dry: boolean): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	const { sources: skillSources } = mergedSkills(ctx);
	const { sources: agentSources } = mergedAgents(ctx);

	report.info("== dg-skills sync opencode probe ==");
	report.info(`agents: ${agentSources.length} merged source(s)`);
	report.info(`skills: ${skillSources.length} merged source(s)`);
	report.info(`hooks source: ${p.hooksSrc ?? "(not configured)"}`);
	report.info(`plugins source: ${p.pluginsSrc ?? "(not configured)"}`);
	report.info(`OpenCode config: ${p.opencodeConfig}`);
	report.info("");
	report.info("Compatibility matrix:");
	report.info("  agents  -> copy+transform to *.md (opencode format)");
	report.info("  skills  -> copy+transform to OpenCode-recognized frontmatter");
	report.info("  hooks   -> copy from configured root");
	report.info("  plugins -> copy from configured root");
	report.info("  config  -> update opencode.json plugin list");

	if (dry) {
		report.info("");
		report.info("Planned operations (dry-run):");
		report.info(`  - Transform ${agentSources.length} Claude agent(s) into ${p.agentsDst}`);
		report.info(`  - Copy+transform ${skillSources.length} skill dir(s) into ${p.skillsDst}`);
		report.info("  - Rewrite tool scratch paths to the configured scratch directory");
		report.info(`  - Copy hooks into ${p.hooksDst}`);
		report.info(`  - Copy plugin dirs into ${p.pluginsDst}`);
		report.info(`  - Update ${p.opencodeConfig} plugin list`);
	}
	return report;
}

async function apply(ctx: SyncContext, flags: OpencodeFlags): Promise<SyncReport> {
	const report = new SyncReport();
	const secretsOk = await checkRequiredSecrets(ctx, report);
	if (!secretsOk) return report;

	syncAgents(ctx, report);
	syncSkills(ctx, report);
	syncHooks(ctx, report);
	syncPlugins(ctx, report);
	updateConfigPlugins(ctx, report);
	verifyAgents(ctx, report);

	if (flags.syncDtf) {
		report.info("--sync-dtf has no effect; dotfile-tracker integration is a manual local step");
	}
	return report;
}

async function verify(ctx: SyncContext): Promise<SyncReport> {
	const report = new SyncReport();
	const p = paths(ctx);
	verifyAgents(ctx, report);
	verifySkills(ctx, report);

	const configFiles = existsSync(p.configHome)
		? readdirSync(p.configHome, { withFileTypes: true })
				.filter((e) => e.isFile() && (e.name.endsWith(".json") || e.name.endsWith(".yaml")))
				.map((e) => join(p.configHome, e.name))
		: [];
	for (const hit of checkSecretWall(configFiles)) {
		report.fail(`secret-wall: secret literal detected in ${hit.path}`);
	}

	if (report.ok) report.info("verify: OK");
	return report;
}

export const opencodeTarget: SyncTarget<OpencodeFlags> = {
	id: "opencode",
	usage: "sync opencode <probe|dry-run|apply|verify> [--sync-dtf]",
	parseFlags(argv) {
		let syncDtf = false;
		for (const arg of argv) {
			if (arg === "--sync-dtf") syncDtf = true;
			else return { error: `unknown option: ${arg}` };
		}
		return { flags: { syncDtf } };
	},
	probe: (ctx) => probeOrDryRun(ctx, false),
	dryRun: (ctx) => probeOrDryRun(ctx, true),
	apply,
	verify: (ctx) => verify(ctx),
};
