import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const MARKETPLACE_PATH = join(".claude-plugin", "marketplace.json");
const EXIT_UNKNOWN_PLUGIN = 1;
const EXIT_UNREACHABLE = 3;
const EXIT_MISSING_MARKETPLACE = 2;

type GithubSource = { source: "github"; repo: string; ref: string; sha: string };
type Plugin = { name: string; source: string | GithubSource };
type Marketplace = { plugins: Plugin[] };

class BumpError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
	) {
		super(message);
	}
}

function parseLsRemote(output: string, ref: string): string | undefined {
	const rows = output
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((row): row is [string, string] => /^[0-9a-f]{40}$/.test(row[0] ?? ""));
	const peeled = rows.find(([, name]) => name === `refs/tags/${ref}^{}`);
	const exact = rows.find(([, name]) => name === `refs/heads/${ref}` || name === `refs/tags/${ref}`);
	return (peeled ?? exact)?.[0];
}

function resolveSha(repo: string, ref: string): string {
	let result: ReturnType<typeof Bun.spawnSync>;
	try {
		result = Bun.spawnSync(["git", "ls-remote", `https://github.com/${repo}.git`, ref, `${ref}^{}`], { stdout: "pipe", stderr: "pipe" });
	} catch (error) {
		throw new BumpError(`cannot run git: ${error instanceof Error ? error.message : error}`, EXIT_UNREACHABLE);
	}
	if (result.exitCode !== 0)
		throw new BumpError(`cannot reach ${repo}: ${result.stderr.toString().trim()}`, EXIT_UNREACHABLE);
	const sha = parseLsRemote(result.stdout.toString(), ref);
	if (!sha) throw new BumpError(`${repo} has no ref ${ref}`, EXIT_UNKNOWN_PLUGIN);
	return sha;
}

function bump(name: string, refOverride: string | undefined): string {
	if (!existsSync(MARKETPLACE_PATH))
		throw new BumpError(`${MARKETPLACE_PATH} not found in ${process.cwd()}`, EXIT_MISSING_MARKETPLACE);
	const text = readFileSync(MARKETPLACE_PATH, "utf8");
	const marketplace = JSON.parse(text) as Marketplace;
	const plugin = marketplace.plugins.find((entry) => entry.name === name);
	if (!plugin || typeof plugin.source === "string")
		throw new BumpError(`no github plugin named ${name}`, EXIT_UNKNOWN_PLUGIN);
	const source = plugin.source;
	const ref = refOverride ?? source.ref;
	if (!/^[\w./-]+$/.test(ref)) throw new BumpError(`invalid ref ${ref}`, EXIT_UNKNOWN_PLUGIN);
	const next = resolveSha(source.repo, ref);
	const previous = source.sha;
	if (next === previous && ref === source.ref) return `${name}: ${previous} unchanged`;
	const nameAt = text.search(new RegExp(`"name":\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
	const start = text.lastIndexOf("{", nameAt);
	let depth = 0;
	let end = start;
	for (; end < text.length; end++) {
		if (text[end] === "{") depth++;
		if (text[end] === "}" && --depth === 0) break;
	}
	const block = text
		.slice(start, end)
		.replace(previous, next)
		.replace(/("ref":\s*")[^"]*"/, (_, head: string) => `${head}${ref}"`);
	writeFileSync(MARKETPLACE_PATH, text.slice(0, start) + block + text.slice(end));
	if (next === previous) return `${name}: ref ${source.ref} -> ${ref}, sha ${previous} unchanged`;
	return `${name}: ${previous} -> ${next}`;
}

if (import.meta.main) {
	try {
		const { values, positionals } = parseArgs({
			args: Bun.argv.slice(2),
			options: { ref: { type: "string" } },
			allowPositionals: true,
		});
		const [name] = positionals;
		if (!name) throw new BumpError("usage: bump-plugin-pin.ts <name> [--ref <branch-or-tag>]", EXIT_UNKNOWN_PLUGIN);
		console.log(bump(name, values.ref));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = error instanceof BumpError ? error.exitCode : EXIT_UNKNOWN_PLUGIN;
	}
}
