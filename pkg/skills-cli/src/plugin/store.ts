import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { readDgToml, resolveDgPaths, writeDgToml, writeDgTomlDoc, writeFileAtomic } from "@dg/common/node";
import type { Pin } from "./source";
import { hashTree } from "./tree";

export type Env = Record<string, string | undefined>;

export type PluginRecord = {
	name: string;
	kind: "skill";
	source: string;
	pin: Pin;
	treeSha256: string;
	approvedSha256: string | null;
};

const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const RECORD_FILE = "dg-plugin.json";

export function assertName(name: string): void {
	if (!PLUGIN_NAME.test(name))
		throw new DgCliError(`dg plugin: ${JSON.stringify(name)} is not a plugin name. Next: use lowercase letters, digits and hyphens, starting with a letter.`);
}

export function pluginsRoot(env: Env): string {
	return join(resolveDgPaths({ env }).dataDir, "plugins");
}

export function pluginFolder(name: string, env: Env): string {
	assertName(name);
	return join(pluginsRoot(env), name);
}

export function readRecord(name: string, env: Env): PluginRecord {
	const file = join(pluginFolder(name, env), RECORD_FILE);
	if (!existsSync(file)) throw new DgCliError(`dg plugin: ${name} is not installed. Next: run dg plugin list, or dg plugin add <source>.`);
	return parseRecord(name, file, readFileSync(file, "utf8"));
}

const RECORD_KEYS = ["approvedSha256", "kind", "name", "pin", "source", "treeSha256"];

function parseRecord(name: string, file: string, text: string): PluginRecord {
	const broken = (why: string) =>
		new DgCliError(`dg plugin: ${file} ${why}. Next: run dg plugin remove ${name}, then dg plugin add the source again.`);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw broken("is not valid JSON");
	}
	if (!isObject(value) || Object.keys(value).sort().join() !== RECORD_KEYS.join()) throw broken(`must hold exactly the keys ${RECORD_KEYS.join(", ")}`);
	if (value.name !== name) throw broken(`names ${JSON.stringify(value.name)}, not ${name}`);
	const { pin } = value;
	const pinOk = isObject(pin) && Object.keys(pin).sort().join() === "kind,value" && (pin.kind === "sha256" || pin.kind === "commit") && typeof pin.value === "string";
	const textOk = value.kind === "skill" && typeof value.source === "string" && typeof value.treeSha256 === "string";
	if (!pinOk || !textOk || !(value.approvedSha256 === null || typeof value.approvedSha256 === "string")) throw broken("has a field of the wrong type");
	return value as PluginRecord;
}

export function isApproved(record: PluginRecord, env: Env): boolean {
	return record.approvedSha256 !== null && record.approvedSha256 === record.treeSha256 && hashTree(join(pluginFolder(record.name, env), "src")) === record.treeSha256;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function writeRecord(record: PluginRecord, env: Env): void {
	writeFileAtomic(join(pluginFolder(record.name, env), RECORD_FILE), `${JSON.stringify(record, null, "\t")}\n`, 0o600);
}

export function installedNames(env: Env): string[] {
	const root = pluginsRoot(env);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && PLUGIN_NAME.test(entry.name) && existsSync(join(root, entry.name, RECORD_FILE)))
		.map((entry) => entry.name)
		.sort();
}

export function ensureRoot(env: Env): string {
	const root = pluginsRoot(env);
	mkdirSync(root, { recursive: true });
	return root;
}

export function isEnabled(name: string, env: Env): boolean {
	return readDgToml(env).plugins[name]?.enabled === true;
}

export function writeEnabled(name: string, enabled: boolean, env: Env): void {
	writeDgToml(`plugins.${name}.enabled`, enabled, env);
}

export function writeSource(name: string, source: string, env: Env): void {
	writeDgToml(`plugins.${name}.source`, source, env);
}

export function removeSection(name: string, env: Env): void {
	const file = resolveDgPaths({ env }).configTomlPath;
	if (!existsSync(file)) return;
	const raw = Bun.TOML.parse(readFileSync(file, "utf8")) as { plugins?: Record<string, unknown> };
	if (raw.plugins === undefined || !(name in raw.plugins)) return;
	delete raw.plugins[name];
	if (Object.keys(raw.plugins).length === 0) delete raw.plugins;
	writeDgTomlDoc(raw, file);
}

export function removeFolder(path: string): void {
	rmSync(path, { recursive: true, force: true });
}
