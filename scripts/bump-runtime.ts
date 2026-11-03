import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const RUNTIME_PATH = join("pkg", "launcher", "runtime.json");
const MISE_PATH = join(".mise", "config.toml");
const WORKFLOWS_PATH = join(".github", "workflows");

type RuntimeAsset = { file: string; sha256: string };
type RuntimeJson = { version: string; assets: Record<string, RuntimeAsset> };

export function parseShasums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([0-9A-Fa-f]{64})\s+\*?(\S+)$/.exec(line.trim());
		if (match) sums.set(match[2] as string, (match[1] as string).toLowerCase());
	}
	return sums;
}

export function rewriteRuntime(runtime: RuntimeJson, version: string, sums: Map<string, string>): RuntimeJson {
	const assets: Record<string, RuntimeAsset> = {};
	for (const [key, { file }] of Object.entries(runtime.assets)) {
		const sha256 = sums.get(file);
		if (!sha256) throw new Error(`SHASUMS256.txt for bun-v${version} has no entry for ${file}`);
		assets[key] = { file, sha256 };
	}
	return { version, assets };
}

export function rewriteMise(text: string, version: string): string {
	const pattern = /^(bun\s*=\s*")[^"]*(")/m;
	if (!pattern.test(text)) throw new Error(`no bun pin found in ${MISE_PATH}`);
	return text.replace(pattern, `$1${version}$2`);
}

export function rewriteWorkflow(text: string, version: string): string {
	return text.replace(/^(\s*bun-version:\s*)\S+/gm, `$1${version}`);
}

async function fetchShasums(version: string): Promise<string> {
	const url =
		process.env.DG_BUN_SHASUMS_URL ??
		`https://github.com/oven-sh/bun/releases/download/bun-v${version}/SHASUMS256.txt`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`could not download ${url}: ${response.status}`);
	return response.text();
}

export async function bumpRuntime(root: string, version: string): Promise<void> {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid bun version: ${version}`);
	const runtimePath = join(root, RUNTIME_PATH);
	const runtime = JSON.parse(readFileSync(runtimePath, "utf8")) as RuntimeJson;
	const next = rewriteRuntime(runtime, version, parseShasums(await fetchShasums(version)));
	writeFileSync(runtimePath, `${JSON.stringify(next, null, "\t")}\n`);

	const misePath = join(root, MISE_PATH);
	writeFileSync(misePath, rewriteMise(readFileSync(misePath, "utf8"), version));

	const workflows = join(root, WORKFLOWS_PATH);
	for (const name of readdirSync(workflows).filter((entry) => entry.endsWith(".yml"))) {
		const path = join(workflows, name);
		const text = readFileSync(path, "utf8");
		const updated = rewriteWorkflow(text, version);
		if (updated !== text) writeFileSync(path, updated);
	}
}

if (import.meta.main) {
	try {
		const { values, positionals } = parseArgs({
			args: Bun.argv.slice(2),
			options: { root: { type: "string" } },
			allowPositionals: true,
		});
		const [version] = positionals;
		if (!version) throw new Error("usage: bump-runtime.ts <bun-version> [--root <dir>]");
		await bumpRuntime(values.root ?? join(import.meta.dir, ".."), version);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
