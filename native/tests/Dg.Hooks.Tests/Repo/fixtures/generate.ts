import { spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	lutimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { main as hooksMain } from "../../../../../pkg/skills-cli/src/hooks/cli";
import { runNow } from "../../../../../pkg/skills-cli/src/hooks/defs/daily-prune";
import { runHook } from "../../../../../pkg/skills-cli/src/hooks/run";
import type {
	CommandResult,
	CommandRunner,
	HookSeams,
} from "../../../../../pkg/skills-cli/src/hooks/types";

interface Entry {
	path: string;
	kind?: "file" | "dir" | "symlink";
	ageDays?: number;
	target?: string;
	mode?: string;
}
interface Repo {
	path: string;
	files: Record<string, string>;
	worktrees?: { path: string; branch: string }[];
}
interface Rule extends Partial<CommandResult> {
	match: string[];
}
interface Case {
	hook: "daily-prune" | "spec-plan-lint";
	args?: string[];
	stdin?: unknown;
	entries?: Entry[];
	repos?: Repo[];
	runner?: Rule[];
	env?: Record<string, string | null>;
	spawnThrows?: boolean;
}

const dir = import.meta.dir;
const check = process.argv.includes("--check");
const stale: string[] = [];
const DAY_MS = 86_400_000;
const GIT_ENV = {
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function emit(name: string, text: string): void {
	const file = join(dir, name);
	if (check) {
		let current = "";
		try {
			current = readFileSync(file, "utf8");
		} catch {}
		if (current !== text) stale.push(name);
		return;
	}
	writeFileSync(file, text);
}

function git(cwd: string, ...args: string[]): void {
	const r = spawnSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function guardRoot(root: string): void {
	const base = realpathSync(process.env["TMPDIR"] || tmpdir());
	if (!root.startsWith(`${base}/`))
		throw new Error(`refusing fixture root outside ${base}: ${root}`);
}

function build(root: string, c: Case, nowSec: number): void {
	guardRoot(root);
	for (const sub of ["scratch", "state", "code", "home", "outside", "xdg"])
		mkdirSync(join(root, sub), { recursive: true, mode: 0o700 });
	for (const repo of c.repos ?? []) {
		const path = join(root, repo.path);
		mkdirSync(path, { recursive: true });
		git(path, "init", "-q", "-b", "main");
		for (const [rel, text] of Object.entries(repo.files)) {
			mkdirSync(dirname(join(path, rel)), { recursive: true });
			writeFileSync(join(path, rel), text);
		}
		git(path, "add", "-A");
		git(path, "commit", "-q", "-m", "init");
		for (const wt of repo.worktrees ?? []) {
			mkdirSync(dirname(join(root, wt.path)), { recursive: true });
			git(path, "worktree", "add", "-q", "-b", wt.branch, join(root, wt.path));
		}
	}
	const ages = new Map<string, number>();
	const kinds = new Map<string, string>();
	const links = new Set<string>();
	for (const e of c.entries ?? []) {
		const path = join(root, e.path);
		const kind = e.kind ?? "file";
		kinds.set(path, kind);
		ages.set(path, e.ageDays ?? 0);
		if (kind === "dir") mkdirSync(path, { recursive: true });
		else if (kind === "symlink") {
			mkdirSync(dirname(path), { recursive: true });
			symlinkSync(e.target!.replaceAll("<ROOT>", root), path);
			links.add(path);
		} else {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "x");
		}
	}
	for (const [path, age] of ages) {
		for (let d = dirname(path); d.startsWith(`${root}/`); d = dirname(d)) {
			if (kinds.get(d) !== undefined) continue;
			const known = ages.get(`implicit:${d}`);
			if (known === undefined || age < known) ages.set(`implicit:${d}`, age);
		}
	}
	const stamp = (path: string, age: number) => {
		const t = nowSec - age * 86_400;
		if (links.has(path)) lutimesSync(path, t, t);
		else utimesSync(path, t, t);
	};
	for (const [key, age] of ages)
		if (!key.startsWith("implicit:")) stamp(key, age);
	for (const [key, age] of ages)
		if (key.startsWith("implicit:")) stamp(key.slice("implicit:".length), age);
	for (const e of c.entries ?? [])
		if (e.mode) chmodSync(join(root, e.path), Number.parseInt(e.mode, 8));
}

function tree(root: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			if (name === ".git") continue;
			const p = join(d, name);
			const rel = relative(root, p);
			const st = lstatSync(p);
			if (st.isSymbolicLink())
				out.push(`${rel} -> ${readlinkSync(p).replaceAll(root, "<ROOT>")}`);
			else if (st.isDirectory()) {
				out.push(`${rel}/`);
				walk(p);
			} else out.push(rel);
		}
	};
	walk(root);
	return out.sort();
}

function scripted(rules: Rule[], calls: string[], root: string): CommandRunner {
	return async (argv, opts) => {
		const from = argv.findIndex(
			(a, k) => k > 0 && (a === "spec" || a === "worktree"),
		);
		const tail = argv.slice(from);
		calls.push(`call: ${tail.join(" ")} (cwd=${opts?.cwd ?? ""})`.replaceAll(root, "<ROOT>"));
		const rule = rules.find((r) => r.match.every((m, i) => tail[i] === m));
		return { status: 0, stdout: "", stderr: "", ...rule };
	};
}

function norm(text: string, root: string): string {
	return text.replaceAll(root, "<ROOT>");
}

function logSections(lines: string[], root: string): string {
	const [header = "", ...body] = lines.map((l) => norm(l, root));
	const head = header.replace(/^daily-prune \S+/, "daily-prune <NOW>");
	return `${[head, ...body.sort()].join("\n")}\n`;
}

async function* once(text: string): AsyncGenerator<string> {
	yield text;
}

async function runCase(name: string, c: Case): Promise<string> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "dg-hooks-repo-")));
	const priorEnv = { ...process.env };
	try {
		const nowSec = Math.floor(Date.now() / 1000);
		Object.assign(process.env, GIT_ENV, {
			HOME: join(root, "home"),
			XDG_CONFIG_HOME: join(root, "xdg"),
			DG_PATH_FENCE: root,
		});
		build(root, c, nowSec);
		const env: Record<string, string | undefined> = {
			HOME: join(root, "home"),
			DG_PATH_FENCE: root,
			AI_SCRATCH_DIR: join(root, "scratch"),
			AI_STATE_DIR: join(root, "state"),
			DAILY_PRUNE_CODE_ROOT: join(root, "code"),
			DAILY_PRUNE_WORKTREE_ROOT: join(root, "code", "worktrees"),
		};
		for (const [k, v] of Object.entries(c.env ?? {}))
			env[k] = v === null ? undefined : v.replaceAll("<ROOT>", root);
		const before = tree(root);
		const calls: string[] = [];
		const run = scripted(c.runner ?? [], calls, root);
		let stdout = "";
		let stderr = "";
		const seams: HookSeams = {
			run,
			which: () => undefined,
			spawnDetached: (argv) => {
				const from = argv.indexOf("hooks");
				calls.push(`spawn: ${argv.slice(from).join(" ")}`);
				if (c.spawnThrows) throw new Error("spawn failed");
			},
			stdout: (t) => void (stdout += t),
			stderr: (t) => void (stderr += t),
		};
		const args = c.args ?? [];
		const stdin = JSON.stringify(c.stdin ?? { hook_event_name: "SessionStart" });
		let exit: number;
		let log: string[] | undefined;
		if (c.hook === "spec-plan-lint")
			exit = await runHook("spec-plan-lint", once(stdin), env, seams);
		else if (args.includes("--now")) {
			log = [];
			await runNow(env, run, args.includes("--dry-run"), (l) => void log!.push(l));
			exit = 0;
		} else
			exit = await hooksMain(["run", "daily-prune", ...args], {
				stdin: once(stdin),
				env,
				seams,
				cwd: root,
			});
		const after = tree(root);
		const sections: [string, string][] = [
			["exit", `${exit}\n`],
			["stdout", norm(stdout, root)],
			["stderr", norm(stderr, root)],
			["calls", `${calls.sort().join("\n")}${calls.length ? "\n" : ""}`],
		];
		if (c.hook === "daily-prune") {
			const stampPath = join(root, "state", "hooks", "daily-prune.stamp");
			let stamp = "absent";
			try {
				stamp = `${Math.round((Date.now() - lstatSync(stampPath).mtimeMs) / DAY_MS)} days`;
			} catch {}
			sections.push(["stamp", `${stamp}\n`]);
			if (log) {
				sections.push(["log", logSections(log, root)]);
				let logfile = "";
				try {
					logfile = readFileSync(join(root, "scratch", "hooks", "daily-prune.log"), "utf8");
				} catch {}
				sections.push(["logfile", logfile ? logSections(logfile.trimEnd().split("\n"), root) : ""]);
			}
			sections.push(["tree", `${after.join("\n")}\n`]);
			const gone = before.filter((p) => !after.includes(p));
			sections.push(["pruned", `${gone.join("\n")}${gone.length ? "\n" : ""}`]);
		}
		return sections.map(([k, v]) => `--- ${k}\n${v}`).join("");
	} finally {
		for (const k of Object.keys(process.env)) if (!(k in priorEnv)) delete process.env[k];
		Object.assign(process.env, priorEnv);
		rmSync(root, { recursive: true, force: true });
	}
}

for (const file of readdirSync(dir).filter((n) => n.endsWith(".case.json")).sort()) {
	const name = file.slice(0, -".case.json".length);
	const c: Case = JSON.parse(readFileSync(join(dir, file), "utf8"));
	emit(`${name}.expected.txt`, await runCase(name, c));
}

if (check && stale.length > 0) {
	console.error(`stale fixtures: ${stale.join(", ")}\nrun: bun ${relative(process.cwd(), import.meta.path)}`);
	process.exit(1);
}
