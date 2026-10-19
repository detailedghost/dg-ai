#!/usr/bin/env bun
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const BOOTSTRAP_URL =
	/(raw\.githubusercontent\.com\/detailedghost\/dg-ai\/)(master|skills-v\d+\.\d+\.\d+[\w.-]*)(\/pkg\/skills-cli\/bootstrap\.(?:sh|ps1))/g;

const REPO_ROOT = resolve(import.meta.dir, "..");
const ROOTS = [
	"README.md",
	"docs",
	"plugins/dg/skills",
	"pkg/skills-cli/bootstrap.sh",
	"pkg/skills-cli/bootstrap.ps1",
];
const SCRIPTS = /\.(?:sh|ps1)$/;

function markdownFiles(path: string): string[] {
	if (path.endsWith(".md") || SCRIPTS.test(path)) return [path];
	return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() || entry.name.endsWith(".md")
			? markdownFiles(join(path, entry.name))
			: [],
	);
}

export function pinBootstrapUrls(text: string, tag: string): string {
	return text.replace(BOOTSTRAP_URL, (_m, head: string, _ref: string, tail: string) => `${head}${tag}${tail}`);
}

export function currentTag(): string {
	const pkg = JSON.parse(
		readFileSync(join(REPO_ROOT, "pkg/skills-cli/package.json"), "utf8"),
	) as { version: string };
	return `skills-v${pkg.version}`;
}

export function pinnedFiles(): string[] {
	return ROOTS.flatMap((root) => markdownFiles(join(REPO_ROOT, root)));
}

if (import.meta.main) {
	const check = process.argv.includes("--check");
	const tag = currentTag();
	const stale: string[] = [];
	for (const file of pinnedFiles()) {
		const before = readFileSync(file, "utf8");
		const after = pinBootstrapUrls(before, tag);
		if (before === after) continue;
		stale.push(file);
		if (!check) writeFileSync(file, after);
	}
	if (check && stale.length > 0) {
		console.error(`Bootstrap URLs not pinned to ${tag}:\n${stale.join("\n")}`);
		process.exit(1);
	}
	console.log(check ? `All bootstrap URLs pinned to ${tag}` : `Pinned ${stale.length} file(s) to ${tag}`);
}
