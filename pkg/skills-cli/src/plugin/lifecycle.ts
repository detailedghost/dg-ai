import { existsSync, mkdtempSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { DgCliError } from "@dg/common";
import { parseManifest, permissionReport, type PluginManifest } from "@dg/common/plugins/manifest";
import { SKILL_NAME } from "../install/recommended-skills-only";
import { registerOnHosts, unregisterFromHosts } from "./hosts";
import { type Pin, stageSource } from "./source";
import {
	assertName,
	type Env,
	ensureRoot,
	installedNames,
	isApproved,
	isEnabled,
	pluginFolder,
	pluginSrcDir,
	type PluginRecord,
	readRecord,
	removeFolder,
	removeSection,
	writeEnabled,
	writeRecord,
	writeSource,
} from "./store";
import { copyTree, hashTree, listTree } from "./tree";

export type AddResult = { name: string; kind: "skill"; pin: Pin; approved: false };
export type UpdateResult = { name: string; changed: boolean; approved: boolean; pin: Pin };
export type ListRow = { name: string; kind: "skill"; pin: Pin; enabled: boolean; approved: boolean; source: string };
export type VerifyReport = {
	name: string;
	approved: boolean;
	intact: boolean;
	problems: string[];
	enforced: string[];
	unenforced: string[];
};

const MANIFEST_FILE = "plugin.toml";

type SkillDir = { name: string; prefix: string };

function skillDirs(files: string[], pluginName: string): SkillDir[] {
	if (files.includes("SKILL.md")) return [{ name: pluginName, prefix: "" }];
	const found = new Map<string, SkillDir>();
	for (const file of files) {
		const parts = file.split("/");
		if (parts.at(-1) !== "SKILL.md") continue;
		const [first, second, third] = parts;
		const dir = first === "skills" && parts.length === 3 ? second : parts.length === 2 ? first : undefined;
		if (dir === undefined || (first === "skills" && third !== "SKILL.md")) continue;
		if (!SKILL_NAME.test(dir)) throw new DgCliError(`dg plugin: ${dir} is not a skill folder name. Next: rename it to lowercase letters, digits and hyphens.`);
		found.set(dir, { name: dir, prefix: first === "skills" ? `skills/${dir}/` : `${dir}/` });
	}
	return [...found.values()];
}

function readManifest(srcDir: string): PluginManifest | undefined {
	const file = join(srcDir, MANIFEST_FILE);
	if (!existsSync(file)) return undefined;
	const manifest = parseManifest(readFileSync(file, "utf8"), file);
	if (manifest.kind !== "skill")
		throw new DgCliError(`dg plugin: ${file}: kind ${manifest.kind} is not a skill. Next: dg plugin add installs skill bundles only.`);
	return manifest;
}

function defaultName(source: string): string {
	return basename(source.replace(/\/+$/, "")).replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "");
}

function unload(name: string, env: Env): void {
	removeFolder(join(pluginFolder(name, env), "skills"));
}

function disableAndUnload(name: string, env: Env): void {
	unregisterFromHosts(name, env);
	unload(name, env);
	if (isEnabled(name, env)) writeEnabled(name, false, env);
}

function load(record: PluginRecord, env: Env): void {
	const src = pluginSrcDir(record.name, env);
	const target = join(pluginFolder(record.name, env), "skills");
	removeFolder(target);
	const files = listTree(src);
	for (const skill of skillDirs(files, record.name)) copyTree(src, join(target, skill.name), files, skill.prefix);
}

function syncHosts(record: PluginRecord, env: Env): void {
	if (isEnabled(record.name, env) && isApproved(record, env)) registerOnHosts(record.name, join(pluginFolder(record.name, env), "skills"), env);
	else unregisterFromHosts(record.name, env);
}

function notApproved(name: string): DgCliError {
	return new DgCliError(`dg plugin: ${name} is not approved, so its text and helper stay untrusted. Next: review it, then run dg plugin verify ${name} --approve.`);
}

/** Installs a skill bundle from a git url or path, pinned and untrusted until `verifyPlugin` approves it. */
export function addPlugin(input: { source: string; pin?: Pin; name?: string }, env: Env = process.env): AddResult {
	const root = ensureRoot(env);
	const staging = mkdtempSync(join(root, ".staging-"));
	let created: string | undefined;
	try {
		const staged = stageSource(input.source, staging, input.pin);
		const manifest = readManifest(staged.dir);
		const name = input.name ?? manifest?.name ?? defaultName(input.source);
		assertName(name);
		if (skillDirs(staged.files, name).length === 0)
			throw new DgCliError(`dg plugin: ${input.source} has no SKILL.md. Next: point dg plugin add at a repo or folder that ships a skill.`);
		const folder = pluginFolder(name, env);
		if (existsSync(folder)) throw new DgCliError(`dg plugin: ${name} is already installed. Next: run dg plugin update ${name}, or dg plugin remove ${name}.`);
		renameSync(staged.dir, join(staging, "src"));
		renameSync(staging, folder);
		created = name;
		writeRecord({ name, kind: "skill", source: input.source, pin: staged.pin, treeSha256: staged.treeSha256, approvedSha256: null }, env);
		writeSource(name, input.source, env);
		writeEnabled(name, false, env);
		return { name, kind: "skill", pin: staged.pin, approved: false };
	} catch (error) {
		if (created !== undefined) {
			removeFolder(pluginFolder(created, env));
			removeSection(created, env);
		}
		throw error;
	} finally {
		removeFolder(staging);
	}
}

export function removePlugin(name: string, env: Env = process.env): void {
	readRecord(name, env);
	unregisterFromHosts(name, env);
	removeFolder(pluginFolder(name, env));
	removeSection(name, env);
}

export function setPluginEnabled(name: string, enabled: boolean, env: Env = process.env): void {
	const record = readRecord(name, env);
	if (enabled && !isApproved(record, env)) throw notApproved(name);
	if (enabled) {
		load(record, env);
		registerOnHosts(name, join(pluginFolder(name, env), "skills"), env);
	} else unregisterFromHosts(name, env);
	writeEnabled(name, enabled, env);
}

/** Re-fetches the source. A change in the files drops the approval and disables the plugin. */
export function updatePlugin(name: string, input: { pin?: Pin } = {}, env: Env = process.env): UpdateResult {
	const record = readRecord(name, env);
	const root = ensureRoot(env);
	const staging = mkdtempSync(join(root, ".staging-"));
	try {
		const staged = stageSource(record.source, staging, input.pin);
		readManifest(staged.dir);
		if (skillDirs(staged.files, name).length === 0)
			throw new DgCliError(`dg plugin: ${record.source} no longer has a SKILL.md. Next: keep the installed version, or run dg plugin remove ${name}.`);
		const changed = staged.treeSha256 !== record.treeSha256;
		const src = pluginSrcDir(name, env);
		removeFolder(src);
		renameSync(staged.dir, src);
		const next: PluginRecord = { ...record, pin: staged.pin, treeSha256: staged.treeSha256, approvedSha256: changed ? null : record.approvedSha256 };
		writeRecord(next, env);
		if (changed) disableAndUnload(name, env);
		else if (isApproved(next, env)) {
			load(next, env);
			syncHosts(next, env);
		}
		return { name, changed, approved: isApproved(next, env), pin: staged.pin };
	} finally {
		removeFolder(staging);
	}
}

/** Checks the installed files against the record and reports what dg cannot enforce; `approve` records the approval. */
export function verifyPlugin(name: string, input: { approve: boolean }, env: Env = process.env): VerifyReport {
	let record = readRecord(name, env);
	const src = pluginSrcDir(name, env);
	const intact = hashTree(src) === record.treeSha256;
	const problems: string[] = [];
	if (!intact) {
		record = { ...record, approvedSha256: null };
		writeRecord(record, env);
		disableAndUnload(name, env);
		problems.push(`${name} changed since it was installed, so it is unapproved and disabled. Next: run dg plugin update ${name} to restore it, then review and approve it.`);
	} else if (input.approve) {
		record = { ...record, approvedSha256: record.treeSha256 };
		writeRecord(record, env);
		load(record, env);
		syncHosts(record, env);
	}
	const manifest = readManifest(src);
	const permissions = manifest === undefined ? { enforced: [], unenforced: [] } : permissionReport(manifest);
	return { name, approved: intact && isApproved(record, env), intact, problems, ...permissions };
}

export function listPlugins(env: Env = process.env): ListRow[] {
	return installedNames(env).map((name) => {
		const record = readRecord(name, env);
		return { name, kind: record.kind, pin: record.pin, enabled: isEnabled(name, env), approved: isApproved(record, env), source: record.source };
	});
}

/** The helper command of an approved plugin; an unapproved or edited plugin throws. */
export function approvedHelper(name: string, env: Env = process.env): { command: string; args: string[] } {
	const record = readRecord(name, env);
	if (!isApproved(record, env)) throw notApproved(name);
	const entry = readManifest(pluginSrcDir(name, env))?.entry;
	if (entry === undefined || !("command" in entry)) throw new DgCliError(`dg plugin: ${name} ships no helper command. Next: nothing to run.`);
	return { command: entry.command, args: entry.args };
}
