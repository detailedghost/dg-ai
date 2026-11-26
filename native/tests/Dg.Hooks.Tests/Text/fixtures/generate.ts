import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const dir = import.meta.dir;
const repo = join(dir, "../../../../..");
const check = process.argv.includes("--check");
const stale: string[] = [];
const expectedNames = new Set<string>();

type FileSpec = string | { content?: string; mode?: string; symlink?: string };
type Case = {
	name: string;
	hook: string;
	event: unknown;
	env?: Record<string, string | null>;
	files?: Record<string, FileSpec>;
	bin?: Record<string, string>;
	chmod?: Record<string, string>;
	requires?: string[];
};

const LOG_HEAD = `#!/bin/sh
case "$PWD" in "$FIXTURE_ROOT"*) c=\${PWD#"$FIXTURE_ROOT"};; *) c=-;; esac
printf '%s %s | cwd=%s\\n' "\${0##*/}" "$*" "$c" >> "$FIXTURE_ROOT/log"
`;

function emit(name: string, text: string): void {
	expectedNames.add(name);
	const file = join(dir, name);
	if (check) {
		const current = existsSync(file) ? readFileSync(file, "utf8") : "";
		if (current !== text) stale.push(name);
		return;
	}
	writeFileSync(file, text);
}

function mkdirs(path: string): void {
	const missing: string[] = [];
	for (let p = path; !existsSync(p); p = dirname(p)) missing.push(p);
	for (const p of missing.reverse()) {
		mkdirSync(p);
		chmodSync(p, 0o755);
	}
}

function scriptText(text: string): string {
	return text.startsWith("@log") ? `${LOG_HEAD}${text.slice(4).replace(/^\n/, "")}${text.length > 4 ? "\n" : ""}` : text;
}

function put(path: string, spec: FileSpec): void {
	mkdirs(dirname(path));
	if (typeof spec === "object" && spec.symlink !== undefined) {
		symlinkSync(spec.symlink, path);
		return;
	}
	const { content, mode } = typeof spec === "string" ? { content: spec, mode: undefined } : spec;
	writeFileSync(path, scriptText(content ?? ""));
	chmodSync(path, mode ? Number.parseInt(mode, 8) : 0o644);
}

function snapshot(root: string): string {
	const out: string[] = [];
	const walk = (path: string): void => {
		const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
		for (const entry of entries) {
			const full = join(path, entry.name);
			const rel = relative(root, full).split("\\").join("/");
			if (["bin", "scratch", "home", "dg"].includes(rel)) continue;
			const stat = lstatSync(full);
			if (stat.isDirectory()) walk(full);
			else if (stat.isSymbolicLink()) out.push(`== ${rel} -> ${readlinkSync(full)}\n`);
			else out.push(`== ${rel} ${(stat.mode & 0o777).toString(8)}\n${readFileSync(full, "utf8")}\n`);
		}
	};
	walk(root);
	return out.join("");
}

const scratchBase = /(^|\/)\.(claude|agents|opencode)(\/|$)/.test(tmpdir()) ? "/tmp" : tmpdir();

const cases: Case[] = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));

async function runCase(entry: Case) {
	const root = realpathSync(mkdtempSync(join(scratchBase, "dg-hooks-text-")));
	try {
		const sub = (text: string): string => text.split("<ROOT>").join(root);
		mkdirs(join(root, "bin"));
		mkdirs(join(root, "home"));
		put(join(root, "log"), "");
		put(join(root, "work", ".git", "HEAD"), "");
		for (const bin of entry.requires ?? []) symlinkSync(Bun.which(bin) as string, join(root, "bin", bin));
		for (const [name, text] of Object.entries(entry.bin ?? {})) put(join(root, "bin", name), { content: text, mode: "755" });
		for (const [rel, spec] of Object.entries(entry.files ?? {})) put(join(root, rel), spec);
		for (const [rel, mode] of Object.entries(entry.chmod ?? {})) chmodSync(join(root, rel), Number.parseInt(mode, 8));
		const env: Record<string, string> = {
			HOME: join(root, "home"),
			DG_HOME: join(root, "dg"),
			DG_PATH_FENCE: root,
			AI_SCRATCH_DIR: join(root, "scratch"),
			CLAUDE_CODE_SESSION_ID: "fixsess",
			FIXTURE_ROOT: root,
			PATH: join(root, "bin"),
		};
		for (const [key, value] of Object.entries(entry.env ?? {})) {
			if (value === null) delete env[key];
			else env[key] = sub(value);
		}
		const stdin = typeof entry.event === "string" ? entry.event : sub(JSON.stringify(entry.event));
		const proc = Bun.spawn([process.execPath, join(repo, "pkg/dg/src/index.ts"), "hooks", "run", entry.hook], {
			cwd: tmpdir(),
			env,
			stdin: new TextEncoder().encode(stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		const norm = (text: string): string => text.split(root).join("<ROOT>");
		return { stdout: norm(stdout), stderr: norm(stderr), code, files: norm(snapshot(root)), env };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function available(entry: Case): boolean {
	return (entry.requires ?? []).every((bin) => Bun.which(bin) !== null);
}

const names = new Set<string>();
for (const entry of cases) {
	if (names.has(entry.name)) throw new Error(`duplicate case ${entry.name}`);
	names.add(entry.name);
	if (!available(entry)) {
		for (const ext of ["stdout", "stderr", "code", "files"]) expectedNames.add(`${entry.name}.${ext}`);
		continue;
	}
	const result = await runCase(entry);
	emit(`${entry.name}.stdout`, result.stdout);
	emit(`${entry.name}.stderr`, result.stderr);
	emit(`${entry.name}.code`, `${result.code}\n`);
	emit(`${entry.name}.files`, result.files);
}

const pairs = readFileSync(join(repo, "pkg/skills-cli/src/hooks/data/spelling-pairs.txt"), "utf8").replace(/\n$/, "");
const pairsFile = "../../../../src/Dg.Hooks/Defs/Text/SpellingPairs.cs";
const pairsText = `namespace Dg.Hooks.Defs.Text;\n\ninternal static class SpellingPairs\n{\n    internal const string Text = """\n${pairs}\n""";\n}\n`;
const pairsPath = join(dir, pairsFile);
if (check) {
	if (!existsSync(pairsPath) || readFileSync(pairsPath, "utf8") !== pairsText) stale.push("SpellingPairs.cs");
} else writeFileSync(pairsPath, pairsText);

const orphans = readdirSync(dir).filter((f) => /\.(stdout|stderr|code|files)$/.test(f) && !expectedNames.has(f));
if (check) stale.push(...orphans.map((f) => `orphan ${f}`));
else for (const f of orphans) rmSync(join(dir, f));

if (check && stale.length > 0) {
	console.error(`stale fixtures: ${stale.join(", ")}`);
	process.exit(1);
}
