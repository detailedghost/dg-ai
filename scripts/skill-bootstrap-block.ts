#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const USAGE =
	"usage: bun scripts/skill-bootstrap-block.ts --check|--write [--root <skills dir>]";
const DEFAULT_ROOT = resolve(import.meta.dir, "..", "plugins", "dg", "skills");
const FALLBACK_DIR = "${DG_HOME:-$HOME/.local}/bin";
const OLD_FALLBACK_DIR = "$HOME/.local/bin";

const LEGACY_LAUNCHER = /(?:~|<home>|\$HOME)\/\.dg\/bin\/dg(?:-skills|-agent|-daemon)?(?![\w-])/g;
const SENTENCE =
	/\n *Call `dg[a-z-]*`(?: and `dg[a-z-]*`)* in every later step\. If [^\n]* instead\.\n/;
const FENCE = new RegExp(
	`^( *)\`\`\`(bash|sh)\\n([\\s\\S]*?)^\\1\`\`\`\\n(?:${SENTENCE.source})?`,
	"gm",
);
const CURL = /^curl -fsSL (\S+) \| sh(.*)$/;
const PROGRAM = /^dg(?![\w-])/;
const LAUNCHER = `${FALLBACK_DIR}/dg`;
const UPGRADE_LINE = `{ { dg --version >/dev/null 2>&1 || "${LAUNCHER}" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||`;

function readProbes(lines: string[]): string[] | undefined {
	const probes: string[] = [];
	for (const raw of lines.filter((line) => line.trim() !== UPGRADE_LINE)) {
		for (const part of raw
			.trim()
			.replace(/^\{ /, "")
			.replace(/(?:; \})? *(?:&&|\|\|)$/, "")
			.split(/ && /)) {
			const expression = part
				.trim()
				.replace(/^\{ /, "")
				.replace(/;( \})?$/, "");
			if ([FALLBACK_DIR, OLD_FALLBACK_DIR].some((dir) => expression.startsWith(`"${dir}/`))) continue;
			if (!PROGRAM.test(expression)) return undefined;
			if (!probes.includes(expression)) probes.push(expression);
		}
	}
	return probes.length > 0 ? probes : undefined;
}

const fallback = (expression: string): string => `"${LAUNCHER}"${expression.slice(2)}`;

function group(expressions: string[]): string[] {
	if (expressions.length === 1) return [`${expressions[0]} ||`];
	return expressions.map((expression, index) => {
		const open = index === 0 ? "{ " : "";
		return index === expressions.length - 1
			? `${open}${expression}; } ||`
			: `${open}${expression} &&`;
	});
}

const SENTENCE_TEXT = `Call \`dg\` in every later step. If \`dg\` alone does not answer, also after the bootstrap, call \`${LAUNCHER}\` instead.`;

const TRAILER_IF = /^if .*; then (.*); else .*; fi$/;

function bareTrailer(line: string): string {
	const branch = TRAILER_IF.exec(line)?.[1];
	if (branch) return branch;
	for (const dir of [FALLBACK_DIR, OLD_FALLBACK_DIR]) {
		const prefix = `"${dir}/`;
		if (line.startsWith(prefix)) return line.slice(prefix.length).replace(/^dg"/, "dg");
	}
	return line;
}

function byPath(raw: string, probes: string[]): string {
	const line = bareTrailer(raw);
	if (!PROGRAM.test(line)) return raw;
	return `if ${probes.join(" && ")}; then ${line}; else ${fallback(line)}; fi`;
}

type Block = { probes: string[]; curl: string; trailer: string[]; fence: string; indent: string };

/** The uniform first-run block: the bare launcher, then the launcher path, then the upgrade hint, then the bootstrap, then the launcher path. */
export function renderBlock({ probes, curl, trailer, fence, indent }: Block): string {
	const body = [...group(probes), ...group(probes.map(fallback)), UPGRADE_LINE, curl].map((line, index) =>
		index === 0 ? line : `  ${line}`,
	);
	return [
		`\`\`\`${fence}`,
		...body,
		...trailer.map((line) => byPath(line, probes)),
		"```",
		"",
		SENTENCE_TEXT,
		"",
	]
		.map((line) => (line.length > 0 ? `${indent}${line}` : line))
		.join("\n");
}

function rewriteBlock(
	match: string,
	indent: string,
	fence: string,
	body: string,
): string {
	const lines = body
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => line.slice(indent.length));
	const at = lines.findIndex((line) => CURL.test(line.trim()));
	if (at < 1) return match;
	const probes = readProbes(lines.slice(0, at));
	if (!probes) return match;
	return renderBlock({ probes, curl: (lines[at] ?? "").trim(), trailer: lines.slice(at + 1), fence, indent });
}

/** The file text with bare launcher names and, in a SKILL.md, the uniform first-run block. */
export function rewrite(name: string, text: string): string {
	const bare = text.replace(LEGACY_LAUNCHER, "dg");
	return name.endsWith("SKILL.md") ? bare.replace(FENCE, rewriteBlock) : bare;
}

function textFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		if (entry === "node_modules") return [];
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return textFiles(path);
		return /\.(md|sh|ps1|ts|js|mjs|json|ya?ml|txt)$/.test(entry) ? [path] : [];
	});
}

function main(argv: string[]): number {
	const mode = argv.find((arg) => arg === "--check" || arg === "--write");
	const rootAt = argv.indexOf("--root");
	const root = rootAt >= 0 ? argv[rootAt + 1] : DEFAULT_ROOT;
	if (!mode || !root) {
		console.error(USAGE);
		return 2;
	}
	const drift: string[] = [];
	for (const path of textFiles(root)) {
		const text = readFileSync(path, "utf8");
		const next = rewrite(path, text);
		if (next === text) continue;
		drift.push(relative(root, path));
		if (mode === "--write") writeFileSync(path, next);
	}
	if (mode === "--check" && drift.length > 0) {
		console.error(
			`skill first-run blocks drifted; run bun scripts/skill-bootstrap-block.ts --write:\n${drift.join("\n")}`,
		);
		return 1;
	}
	if (mode === "--write" && drift.length > 0)
		console.log(`rewrote ${drift.length} files`);
	return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
