#!/usr/bin/env bun
/** Peak RSS of a compiled dg per command and per long-running process, checked against budgets. */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dir, "..");
const MB = 1024 * 1024;

type Ctx = { dg: string; home: string; work: string; env: Record<string, string>; phone?: Phone };
type Phone = { relay: string; a: Record<string, string>; b: Record<string, string> };
type Sample = { peak: number; idle?: number; anon?: number; ms: number };
type Case = {
	name: string;
	budget: number;
	long?: boolean;
	phone?: boolean;
	ungated?: boolean;
	measure(ctx: Ctx): Promise<Sample>;
};

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		dg: { type: "string" },
		gate: { type: "boolean", default: false },
		only: { type: "string" },
		idle: { type: "string", default: "5" },
		runs: { type: "string", default: "3" },
		json: { type: "string" },
		env: { type: "string", multiple: true, default: [] },
	},
});
if (!values.dg) throw new Error("usage: bun scripts/ram-budget.ts --dg <compiled dg> [--gate] [--only a,b] [--idle s] [--runs n] [--json file]");
const DG = resolve(values.dg);
const IDLE_MS = Number(values.idle) * 1000;
const RUNS = Number(values.runs);
const EXTRA_ENV = Object.fromEntries((values.env ?? []).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function dropPageCache(file: string): void {
	if (process.platform !== "linux") return;
	spawnSync("sync", [file]);
	spawnSync("dd", [`if=${file}`, "iflag=nocache", "count=0", "status=none"]);
}

function fencedEnv(root: string, port: number): Record<string, string> {
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const keep = ["PATH", "LANG", "TERM", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"];
	const base = Object.fromEntries(keep.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : [])));
	return {
		...base,
		HOME: home,
		USERPROFILE: home,
		DG_HOME: join(root, "dg"),
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"),
		XDG_STATE_HOME: join(home, ".local", "state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		XDG_RUNTIME_DIR: join(root, "run"),
		AI_SCRATCH_DIR: join(root, "scratch"),
		AI_STATE_DIR: join(root, "state"),
		DG_PATH_FENCE: root,
		DG_KEY_SOURCE: "file",
		DG_PORT: String(port),
		DG_SKILLS_DIR: join(ROOT, "plugins", "dg", "skills"),
		NO_COLOR: "1",
		...EXTRA_ENV,
	};
}

function memory(pid: number): { hwm: number; rss: number; anon: number } | undefined {
	try {
		const kb = (text: string, name: string) => Number(text.match(new RegExp(`${name}:\\s+(\\d+)`))?.[1] ?? 0) * 1024;
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
		return { hwm: kb(status, "VmHWM"), rss: kb(status, "VmRSS"), anon: kb(rollup, "Anonymous") };
	} catch {
		return undefined;
	}
}

async function idle(pid: number, label: string): Promise<void> {
	const every = Math.min(IDLE_MS, 30_000);
	for (let waited = 0; waited < IDLE_MS; waited += every) {
		await sleep(every);
		const now = memory(pid);
		if (IDLE_MS > 30_000 && now) console.error(`  ${label} +${(waited + every) / 1000}s rss ${fmt(now.rss)} anon ${fmt(now.anon)} hwm ${fmt(now.hwm)}`);
	}
}

const PEAK_PY = [
	"import os, sys, time",
	"null = os.open(os.devnull, os.O_WRONLY)",
	"started = time.monotonic()",
	"pid = os.posix_spawn(sys.argv[1], sys.argv[1:], os.environ, file_actions=[(os.POSIX_SPAWN_DUP2, null, 1), (os.POSIX_SPAWN_DUP2, null, 2)])",
	"_, status, usage = os.wait4(pid, 0)",
	"print(usage.ru_maxrss * (1 if sys.platform == 'darwin' else 1024), (time.monotonic() - started) * 1000)",
].join("\n");

async function once(bin: string, args: string[], ctx: Ctx, opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}): Promise<Sample> {
	const child = Bun.spawn(["python3", "-I", "-c", PEAK_PY, bin, ...args], {
		cwd: opts.cwd ?? ctx.work,
		env: opts.env ?? ctx.env,
		stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
		stdout: "pipe",
		stderr: "inherit",
	});
	const [peak, ms] = (await new Response(child.stdout).text()).trim().split(" ").map(Number);
	await child.exited;
	return { peak: peak ?? 0, ms: ms ?? 0 };
}

async function median(run: () => Promise<Sample>): Promise<Sample> {
	const samples: Sample[] = [];
	for (let i = 0; i < RUNS; i++) samples.push(await run());
	samples.sort((x, y) => x.peak - y.peak);
	return samples[Math.floor(samples.length / 2)] as Sample;
}

function dg(name: string, args: string[], budget: number, opts: { cwd?: (ctx: Ctx) => string; stdin?: string } = {}): Case {
	return { name, budget, measure: (ctx) => median(() => once(ctx.dg, args, ctx, { cwd: opts.cwd?.(ctx), stdin: opts.stdin })) };
}

async function serve(
	ctx: Ctx,
	args: string[],
	opts: { env?: Record<string, string>; ready?: (ctx: Ctx) => Promise<void>; drive?: (ctx: Ctx) => Promise<void> } = {},
): Promise<Sample> {
	const started = performance.now();
	const child = spawn(ctx.dg, args, { cwd: ctx.work, env: opts.env ?? ctx.env, stdio: "ignore" });
	const pid = child.pid as number;
	try {
		await (opts.ready?.(ctx) ?? sleep(3000));
		await opts.drive?.(ctx);
		await idle(pid, args.join(" "));
		const end = memory(pid);
		if (!end || child.exitCode !== null) throw new Error(`dg ${args.join(" ")} exited early with ${child.exitCode}`);
		return { peak: end.hwm, idle: end.rss, anon: end.anon, ms: performance.now() - started };
	} finally {
		child.kill("SIGTERM");
		await new Promise((done) => (child.exitCode !== null ? done(undefined) : child.once("exit", done)));
	}
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await sleep(100);
	}
	throw new Error("timed out waiting for a dg process to be ready");
}

function run(ctx: Ctx, args: string[], env = ctx.env): string {
	const result = spawnSync(ctx.dg, args, { cwd: ctx.work, env, encoding: "utf8", timeout: 60_000 });
	if (result.status !== 0) throw new Error(`dg ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
	return result.stdout;
}

async function setupPhone(ctx: Ctx, root: string): Promise<{ phone: Phone; stop: () => void } | undefined> {
	const certDir = join(root, "tls");
	mkdirSync(certDir, { recursive: true });
	const cert = join(certDir, "cert.pem");
	const key = join(certDir, "key.pem");
	const made = spawnSync("openssl", [
		"req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert,
		"-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
	]);
	if (made.status !== 0) return undefined;
	const relayProcess = spawn(process.execPath, [join(import.meta.dir, "ram-budget", "relay.ts"), cert, key], { stdio: ["ignore", "pipe", "inherit"] });
	const relay = await new Promise<string>((done, fail) => {
		relayProcess.stdout.once("data", (chunk: Buffer) => done(chunk.toString().trim()));
		relayProcess.once("exit", () => fail(new Error("the test relay exited")));
	});
	const side = (name: string, port: number) => ({ ...fencedEnv(join(root, name), port), NODE_TLS_REJECT_UNAUTHORIZED: "0" });
	const phone: Phone = { relay, a: side("phone-a", 47_411), b: side("phone-b", 47_412) };
	run(ctx, ["phone", "number", "--as", "alice", "--relay", relay], phone.a);
	run(ctx, ["phone", "number", "--as", "bob", "--relay", relay], phone.b);
	const card = (JSON.parse(run(ctx, ["phone", "invite", "--name", "bob"], phone.a).trim().split("\n").at(-1) as string) as { card: string }).card;
	run(ctx, ["phone", "accept", "--name", "alice", card, "hello"], phone.b);
	return { phone, stop: () => relayProcess.kill() };
}

const BURST = 20;

async function burst(ctx: Ctx): Promise<void> {
	const phone = ctx.phone as Phone;
	for (let i = 0; i < BURST; i++) run(ctx, ["phone", "text", "+alice", `burst message ${i} with a little text in it`], phone.b);
	await sleep(2000);
}

function listener(name: string, budget: number, drive?: (ctx: Ctx) => Promise<void>): Case {
	return {
		name,
		budget,
		long: true,
		phone: true,
		measure: (ctx) =>
			serve(ctx, ["phone", "listen"], {
				env: ctx.phone?.a,
				ready: () => waitFor(() => run(ctx, ["phone", "status"], ctx.phone?.a).includes('"listener":{')),
				drive,
			}),
	};
}

function daemonReady(ctx: Ctx): Promise<void> {
	return waitFor(() => spawnSync(ctx.dg, ["daemon", "status"], { env: ctx.env, encoding: "utf8" }).status === 0);
}

const HOOK_EDIT = JSON.stringify({
	hook_event_name: "PostToolUse",
	tool_name: "Edit",
	tool_input: { file_path: "notes.md", old_string: "a", new_string: "the color of the center" },
	tool_response: { success: true },
	cwd: ".",
});
const HOOK_BASH = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" }, cwd: "." });
const HOOK_PR = JSON.stringify({
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: 'gh pr create --title "fix(x): y" --body "This change fixes the bug. It adds a test."' },
	cwd: ".",
});
const HOOK_SESSION = JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: "." });

const CASES: Case[] = [
	dg("version", ["--version"], 27),
	dg("help", ["--help"], 33),
	dg("completion zsh", ["completion", "zsh"], 27),
	dg("config path", ["config", "path"], 43),
	dg("stat checklist", ["stat", "checklist"], 50),
	dg("job --help", ["job", "--help"], 44),
	dg("pw --help", ["pw", "--help"], 45),
	dg("db --help", ["db", "--help"], 43),
	dg("thrash --help", ["thrash", "--help"], 48),
	dg("prototype --help", ["prototype", "--help"], 46),
	dg("phone status", ["phone", "status"], 49),
	dg("phone contacts", ["phone", "contacts"], 49),
	dg("phone messages", ["phone", "messages"], 49),
	dg("phone unread", ["phone", "unread"], 51),
	dg("hooks list", ["hooks", "list"], 45),
	dg("hooks run spelling", ["hooks", "run", "spelling"], 38, { stdin: HOOK_EDIT }),
	dg("hooks run format", ["hooks", "run", "format"], 38, { stdin: HOOK_EDIT }),
	dg("hooks run pr-prose", ["hooks", "run", "pr-prose"], 38, { stdin: HOOK_PR }),
	dg("hooks run pr-confirm", ["hooks", "run", "pr-confirm"], 37, { stdin: HOOK_BASH }),
	dg("hooks run spec-plan-lint", ["hooks", "run", "spec-plan-lint"], 37, { stdin: HOOK_EDIT }),
	dg("hooks run daily-prune", ["hooks", "run", "daily-prune"], 37, { stdin: HOOK_SESSION }),
	dg("hooks run strip-ai-coauthors", ["hooks", "run", "strip-ai-coauthors"], 34, { stdin: "" }),
	dg("adr lint --all (repo)", ["adr", "lint", "--all"], 68, { cwd: () => ROOT }),
	dg("spec validate", ["spec", "validate", "spec.md"], 52),
	{ ...dg("update --check", ["update", "--check"], 80), ungated: true },
	dg("doctor", ["doctor"], 66),
	{
		name: "daemon idle",
		budget: 47,
		long: true,
		measure: (ctx) => serve(ctx, ["daemon", "serve"], { ready: daemonReady }),
	},
	{
		name: "daemon with jobs",
		budget: 48,
		long: true,
		measure: (ctx) =>
			serve(ctx, ["daemon", "serve"], {
				ready: daemonReady,
				drive: async () => {
					run(ctx, ["job", "add", "--name", "tick", "--cwd", ctx.work, "--every", "1m", "--", "echo", "tick"]);
					run(ctx, ["job", "start", "tick"]);
					for (let i = 0; i < 10; i++) run(ctx, ["job", "list"]);
				},
			}),
	},
	{
		name: "prototype serve",
		budget: 44,
		long: true,
		measure: (ctx) => {
			const page = join(ctx.work, "page.html");
			writeFileSync(page, "<!doctype html><title>p</title><main>prototype</main>");
			const port = 47_431;
			return serve(ctx, ["prototype", "serve", page, "ram", `--port=${port}`, "--idle=600"], {
				ready: () => waitFor(async () => (await fetch(`http://127.0.0.1:${port}/`).catch(() => undefined))?.ok === true),
				drive: async () => {
					for (let i = 0; i < 20; i++) await (await fetch(`http://127.0.0.1:${port}/`)).text();
				},
			});
		},
	},
	listener("phone listener idle", 62),
	listener("phone listener burst", 62, burst),
];

async function floor(root: string): Promise<number> {
	const source = join(root, "floor.ts");
	const out = join(root, process.platform === "win32" ? "floor.exe" : "floor");
	writeFileSync(source, 'console.log("0");\n');
	const built = spawnSync(process.execPath, ["build", "--compile", "--minify", source, "--outfile", out], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(built.stderr);
	dropPageCache(out);
	const ctx = { dg: out, home: root, work: root, env: { PATH: process.env.PATH ?? "" } };
	return (await median(() => once(out, [], ctx))).peak;
}

function seedWork(work: string): void {
	mkdirSync(work, { recursive: true });
	writeFileSync(join(work, "notes.md"), "the color of the center\n");
	writeFileSync(join(work, "spec.md"), "---\nstatus: draft\n---\n# Spec\n");
	spawnSync("git", ["init", "-q", work]);
}

const fmt = (bytes: number) => (bytes / MB).toFixed(1);

async function main(): Promise<number> {
	const root = mkdtempSync(join(tmpdir(), "dg-ram-"));
	const stops: (() => void)[] = [];
	try {
		const bin = join(root, process.platform === "win32" ? "dg.exe" : "dg");
		cpSync(DG, bin);
		dropPageCache(bin);
		const work = join(root, "work");
		seedWork(work);
		const ctx: Ctx = { dg: bin, home: root, work, env: fencedEnv(join(root, "main"), 47_401) };
		const only = values.only?.split(",");
		const cases = CASES.filter((c) => !only || only.some((name) => c.name.startsWith(name)));
		if (cases.some((c) => c.phone)) {
			const phone = await setupPhone(ctx, root);
			if (phone) {
				ctx.phone = phone.phone;
				stops.push(phone.stop);
			}
		}
		const floorBytes = await floor(root);
		console.log(`floor (compiled console.log): ${fmt(floorBytes)} MB`);
		console.log(["case", "peak MB", "over floor", "idle MB", "anon MB", "ms", "budget MB"].join("\t"));
		const results: Record<string, Sample & { budget: number }> = {};
		let failed = 0;
		for (const c of cases) {
			if ((c.long && process.platform !== "linux") || (c.ungated && values.gate)) continue;
			if (c.phone && !ctx.phone) {
				console.log(`${c.name}\tskipped: openssl is missing`);
				continue;
			}
			const sample = await c.measure(ctx);
			results[c.name] = { ...sample, budget: c.budget };
			const over = !c.ungated && sample.peak > c.budget * MB;
			if (over) failed++;
			console.log(
				[c.name, fmt(sample.peak), fmt(sample.peak - floorBytes), sample.idle ? fmt(sample.idle) : "", sample.anon ? fmt(sample.anon) : "", sample.ms.toFixed(0), `${c.ungated ? "report only" : c.budget}${over ? " OVER" : ""}`].join("\t"),
			);
		}
		if (values.json) writeFileSync(values.json, `${JSON.stringify({ floor: floorBytes, results }, null, 2)}\n`);
		return values.gate && failed > 0 ? 1 : 0;
	} finally {
		for (const stop of stops) stop();
		rmSync(root, { recursive: true, force: true });
	}
}

process.exit(await main());
