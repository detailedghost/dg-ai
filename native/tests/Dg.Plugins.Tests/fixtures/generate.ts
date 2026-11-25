import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const dir = import.meta.dir;
const root = join(dir, "..", "..", "..", "..");
const check = process.argv.includes("--check");

type Step = { bun?: string[]; write?: Record<string, string>; rm?: string; symlink?: Record<string, string> };
type Case = { name: string; argv: string[]; steps?: Step[]; env?: Record<string, string>; native?: boolean; person?: boolean };
type Spec = { bundles: Record<string, Record<string, string>>; cases: Case[] };

const spec: Spec = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
const SKIPPED = new Set(["sources", ".bun", ".cache"]);

const AT_A_TERMINAL = ["python3", "-c", "import os, pty, sys; m, s = pty.openpty(); os.set_inheritable(m, True); os.dup2(s, 0); os.execvp(sys.argv[1], sys.argv[1:])"];

function dg(home: string, argv: string[], extra: Record<string, string> = {}, terminal = false) {
	const env = { PATH: process.env.PATH ?? "", HOME: home, DG_HOME: home, DG_PATH_FENCE: home, ...extra };
	const result = Bun.spawnSync([...(terminal ? AT_A_TERMINAL : []), "bun", join(root, "pkg", "dg", "src", "index.ts"), ...argv], { cwd: home, env });
	return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exit: result.exitCode };
}

function snapshot(home: string): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (path: string, prefix: string): void => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (prefix === "" && SKIPPED.has(entry.name)) continue;
			if (entry.isDirectory()) walk(join(path, entry.name), rel);
			else if (entry.isFile()) files[rel] = readFileSync(join(path, entry.name), "utf8").replaceAll(home, "<home>");
			else if (lstatSync(join(path, entry.name)).isSymbolicLink()) files[rel] = "<symlink>";
		}
	};
	walk(home, "");
	return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function put(home: string, rel: string, text: string): void {
	const path = join(home, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text.replaceAll("<home>", home));
}

function run(entry: Case) {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "dg-plugin-cmd-")));
	try {
		for (const [name, files] of Object.entries(spec.bundles)) for (const [rel, text] of Object.entries(files)) put(home, `sources/${name}/${rel}`, text);
		const extra = Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, value]) => [key, value.replaceAll("<home>", home)]));
		for (const step of entry.steps ?? []) {
			if (step.bun) {
				const result = dg(home, step.bun.map((arg) => arg.replaceAll("<home>", home)), extra, true);
				if (result.exit !== 0) throw new Error(`${entry.name}: setup ${step.bun.join(" ")} failed: ${result.stderr}`);
			}
			for (const [rel, text] of Object.entries(step.write ?? {})) put(home, rel, text);
			if (step.rm) rmSync(join(home, step.rm), { force: true });
			for (const [rel, target] of Object.entries(step.symlink ?? {})) symlinkSync(target, join(home, rel));
		}
		const setup = snapshot(home);
		const result = dg(home, entry.argv, extra, entry.person === true);
		const strip = (text: string) => text.replaceAll(home, "<home>");
		return { name: entry.name, setup, stdout: strip(result.stdout), stderr: strip(result.stderr), exit: result.exit, after: snapshot(home) };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

const text = `${JSON.stringify(spec.cases.map(run), null, "\t")}\n`;
const target = join(dir, "cases.expected.json");
if (check) {
	let current = "";
	try {
		current = readFileSync(target, "utf8");
	} catch {}
	if (current !== text) {
		console.error("plugin command fixtures are stale; run bun generate.ts");
		process.exit(1);
	}
} else {
	writeFileSync(target, text);
}
