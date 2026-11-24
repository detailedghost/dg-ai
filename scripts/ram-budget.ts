#!/usr/bin/env bun
/** Peak RSS of a compiled dg per command and per long-running process, checked against budgets. */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { evictFromPageCache } from "@dg/common/node/page-cache";

const ROOT = resolve(import.meta.dir, "..");
const MB = 1024 * 1024;

type Ctx = { dg: string; home: string; work: string; env: Record<string, string>; phone?: Phone };
type Phone = { relay: string; a: Record<string, string>; b: Record<string, string>; others: Record<string, string>[] };
type Sample = { peak: number; idle?: number; anon?: number; ms: number; p95?: number };
type Case = {
	name: string;
	budget: number;
	long?: boolean;
	phone?: boolean;
	ungated?: boolean;
	msBudget?: number;
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
		"latency-runs": { type: "string", default: "50" },
		backlog: { type: "string", default: "100" },
		"fresh-binary": { type: "boolean", default: false },
		json: { type: "string" },
		env: { type: "string", multiple: true, default: [] },
	},
});
const USAGE = [
	"usage: bun scripts/ram-budget.ts --dg <compiled dg>",
	"  [--gate] [--only a,b] [--idle s] [--runs n] [--latency-runs n] [--backlog n] [--fresh-binary] [--env K=V] [--json file]",
].join("\n");

function usageError(detail: string): never {
	console.error(`${detail}\n${USAGE}`);
	process.exit(2);
}

function wholeNumber(raw: string | undefined, flag: string, min: number): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min) {
		usageError(`${flag} must be a whole number of ${min} or more, got "${raw}"`);
	}
	return value;
}

function envPair(pair: string): [string, string] {
	const split = pair.indexOf("=");
	if (split < 1) usageError(`--env must be KEY=VALUE, got "${pair}"`);
	return [pair.slice(0, split), pair.slice(split + 1)];
}

if (process.platform === "win32") usageError("ram-budget runs on Linux and macOS only");
if (!values.dg) usageError("--dg is required");
const DG = resolve(values.dg);
const IDLE_MS = wholeNumber(values.idle, "--idle", 0) * 1000;
const RUNS = wholeNumber(values.runs, "--runs", 1);
const LATENCY_RUNS = wholeNumber(values["latency-runs"], "--latency-runs", 1);
const BACKLOG = wholeNumber(values.backlog, "--backlog", 1);
const EXTRA_ENV = Object.fromEntries((values.env ?? []).map(envPair));

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
	const output = (await new Response(child.stdout).text()).trim();
	const [peak = Number.NaN, rawMs = 0] = output.split(" ").map(Number);
	const code = await child.exited;
	if (code !== 0 || !Number.isFinite(peak) || peak <= 0) {
		throw new Error(`could not measure dg ${args.join(" ")}: python exited ${code}, printed "${output}"`);
	}
	return { peak, ms: Number.isFinite(rawMs) ? rawMs : 0 };
}

function quantile(sorted: number[], fraction: number): number {
	const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
	if (value === undefined) throw new Error("no samples to take a quantile of");
	return value;
}

async function median(run: () => Promise<Sample>, runs: number): Promise<Sample> {
	const samples: Sample[] = [];
	for (let i = 0; i < runs; i++) samples.push(await run());
	const peaks = samples.map((sample) => sample.peak).sort((x, y) => x - y);
	const times = samples.map((sample) => sample.ms).sort((x, y) => x - y);
	return { peak: quantile(peaks, 0.5), ms: quantile(times, 0.5), p95: quantile(times, 0.95) };
}

type CommandOpts = { cwd?: (ctx: Ctx) => string; stdin?: string; msBudget?: number };

function command(name: string, args: string[], budget: number, opts: CommandOpts = {}): Case {
	const runs = opts.msBudget === undefined ? RUNS : Math.max(RUNS, LATENCY_RUNS);
	return {
		name,
		budget,
		msBudget: opts.msBudget,
		measure: (ctx) => median(() => once(ctx.dg, args, ctx, { cwd: opts.cwd?.(ctx), stdin: opts.stdin }), runs),
	};
}

async function serve(
	ctx: Ctx,
	args: string[],
	opts: { env?: Record<string, string>; ready?: (ctx: Ctx) => Promise<void>; drive?: (ctx: Ctx) => Promise<void> } = {},
): Promise<Sample> {
	const started = performance.now();
	const child = spawn(ctx.dg, args, { cwd: ctx.work, env: opts.env ?? ctx.env, stdio: "ignore" });
	const pid = child.pid as number;
	const exited = () => child.exitCode !== null || child.signalCode !== null;
	try {
		await (opts.ready?.(ctx) ?? sleep(3000));
		await opts.drive?.(ctx);
		await idle(pid, args.join(" "));
		const end = memory(pid);
		if (!end || exited()) throw new Error(`dg ${args.join(" ")} exited early with ${child.exitCode ?? child.signalCode}`);
		return { peak: end.hwm, idle: end.rss, anon: end.anon, ms: performance.now() - started };
	} finally {
		child.kill("SIGTERM");
		await new Promise((done) => (exited() ? done(undefined) : child.once("exit", done)));
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

const OTHER_NAMES = ["carol", "dave", "erin"];

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
	const side = (name: string, port: number) => ({ ...fencedEnv(join(root, name), port), NODE_EXTRA_CA_CERTS: cert });
	const others = OTHER_NAMES.map((name, index) => side(`phone-${name}`, 47_413 + index));
	const phone: Phone = { relay, a: side("phone-a", 47_411), b: side("phone-b", 47_412), others };
	const contacts = [["bob", phone.b] as const, ...OTHER_NAMES.map((name, index) => [name, others[index] ?? phone.b] as const)];
	try {
		run(ctx, ["phone", "number", "--as", "alice", "--relay", relay], phone.a);
		for (const [name, env] of contacts) {
			run(ctx, ["phone", "number", "--as", name, "--relay", relay], env);
			const invite = run(ctx, ["phone", "invite", "--name", name], phone.a).trim().split("\n").at(-1) as string;
			const { card } = JSON.parse(invite) as { card: string };
			run(ctx, ["phone", "accept", "--name", "alice", card, "hello"], env);
		}
		const admitting = spawn(ctx.dg, ["phone", "listen"], { cwd: ctx.work, env: phone.a, stdio: "ignore" });
		try {
			await waitFor(() => contacts.every(([name]) => run(ctx, ["phone", "contacts"], phone.a).includes(`"+${name}"`)), 60_000);
		} finally {
			admitting.kill("SIGTERM");
			await new Promise((done) => (admitting.exitCode !== null || admitting.signalCode !== null ? done(undefined) : admitting.once("exit", done)));
		}
		run(ctx, ["phone", "group", "new", "#team", "+bob", "+carol", "+dave", "+erin"], phone.a);
	} catch (error) {
		relayProcess.kill();
		throw error;
	}
	return { phone, stop: () => relayProcess.kill() };
}

const BURST = 20;

async function burst(ctx: Ctx): Promise<void> {
	const phone = ctx.phone as Phone;
	for (let i = 0; i < BURST; i++) run(ctx, ["phone", "text", "+alice", `burst message ${i} with a little text in it`], phone.b);
	await sleep(2000);
}

const pending = (ctx: Ctx): number =>
	(JSON.parse(run(ctx, ["phone", "status"], ctx.phone?.a)) as { pending_voicemail: number }).pending_voicemail;

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

function catchUp(name: string, budget: number): Case {
	return {
		name,
		budget,
		long: true,
		phone: true,
		measure: (ctx) => {
			const phone = ctx.phone as Phone;
			const senders = [phone.b, ...phone.others];
			const before = pending(ctx);
			for (let i = 0; i < BACKLOG; i++) {
				const text = `backlog message ${i}: ${"a realistic line of chat text. ".repeat(1 + (i % 6))}`;
				run(ctx, ["phone", "text", "+alice", text], senders[i % senders.length]);
			}
			return serve(ctx, ["phone", "listen"], {
				env: phone.a,
				ready: () => waitFor(() => pending(ctx) >= before + BACKLOG, 180_000),
			});
		},
	};
}

function daemonReady(ctx: Ctx): Promise<void> {
	return waitFor(() => spawnSync(ctx.dg, ["daemon", "status"], { env: ctx.env, encoding: "utf8" }).status === 0);
}

const HOOK_MS = 52;
const JOBS = 15;

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
	command("version", ["--version"], 24),
	command("help", ["--help"], 26),
	command("completion zsh", ["completion", "zsh"], 25),
	command("config path", ["config", "path"], 33),
	command("stat checklist", ["stat", "checklist"], 48),
	command("job --help", ["job", "--help"], 32),
	command("pw --help", ["pw", "--help"], 33),
	command("db --help", ["db", "--help"], 32),
	command("thrash --help", ["thrash", "--help"], 36),
	command("prototype --help", ["prototype", "--help"], 35),
	command("phone status", ["phone", "status"], 38),
	command("phone contacts", ["phone", "contacts"], 38),
	command("phone messages", ["phone", "messages"], 38),
	command("phone unread", ["phone", "unread"], 40),
	command("hooks list", ["hooks", "list"], 34),
	command("hooks run spelling", ["hooks", "run", "spelling"], 33, { stdin: HOOK_EDIT, msBudget: HOOK_MS }),
	command("hooks run format", ["hooks", "run", "format"], 32, { stdin: HOOK_EDIT, msBudget: HOOK_MS }),
	command("hooks run pr-prose", ["hooks", "run", "pr-prose"], 33, { stdin: HOOK_PR, msBudget: HOOK_MS }),
	command("hooks run pr-confirm", ["hooks", "run", "pr-confirm"], 32, { stdin: HOOK_BASH, msBudget: HOOK_MS }),
	command("hooks run spec-plan-lint", ["hooks", "run", "spec-plan-lint"], 32, { stdin: HOOK_EDIT, msBudget: HOOK_MS }),
	command("hooks run daily-prune", ["hooks", "run", "daily-prune"], 32, { stdin: HOOK_SESSION, msBudget: HOOK_MS }),
	command("hooks run strip-ai-coauthors", ["hooks", "run", "strip-ai-coauthors"], 29, {
		stdin: "",
		msBudget: HOOK_MS,
	}),
	command("adr lint --all (repo)", ["adr", "lint", "--all"], 47, { cwd: () => ROOT }),
	command("spec validate", ["spec", "validate", "spec.md"], 40),
	{ ...command("update --check", ["update", "--check"], 80), ungated: true },
	command("doctor", ["doctor"], 56),
	{
		name: "daemon idle",
		budget: 43,
		long: true,
		measure: (ctx) => serve(ctx, ["daemon", "serve"], { ready: daemonReady }),
	},
	{
		name: "daemon with 15 jobs",
		budget: 44,
		long: true,
		measure: (ctx) =>
			serve(ctx, ["daemon", "serve"], {
				ready: daemonReady,
				drive: async () => {
					for (let i = 0; i < JOBS; i++) {
						run(ctx, ["job", "add", "--name", `tick-${i}`, "--cwd", ctx.work, "--every", "1m", "--", "echo", "tick"]);
					}
					run(ctx, ["job", "start", "tick-0"]);
					for (let i = 0; i < 10; i++) run(ctx, ["job", "list"]);
				},
			}),
	},
	{
		name: "prototype serve",
		budget: 41,
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
	listener("phone listener idle", 61),
	listener("phone listener burst", 59, burst),
	catchUp("phone listener catch-up", 61),
];

async function floor(root: string): Promise<number> {
	const source = join(root, "floor.ts");
	const out = join(root, "floor");
	writeFileSync(source, 'console.log("0");\n');
	const built = spawnSync(process.execPath, ["build", "--compile", "--minify", source, "--outfile", out], { encoding: "utf8" });
	if (built.status !== 0) throw new Error(built.stderr);
	evictFromPageCache(out);
	const ctx = { dg: out, home: root, work: root, env: { PATH: process.env.PATH ?? "" } };
	return (await median(() => once(out, [], ctx), RUNS)).peak;
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
		const bin = join(root, "dg");
		if (values["fresh-binary"]) writeFileSync(bin, readFileSync(DG), { mode: 0o755 });
		else {
			cpSync(DG, bin);
			evictFromPageCache(bin);
		}
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
		const header = ["case", "peak MB", "over floor", "idle MB", "anon MB", "ms", "ms p95", "budget MB", "budget ms"];
		console.log(header.join("\t"));
		const results: Record<string, Sample & { budget: number; msBudget?: number }> = {};
		let failed = 0;
		for (const c of cases) {
			if ((c.long && process.platform !== "linux") || (c.ungated && values.gate)) continue;
			if (c.phone && !ctx.phone) {
				console.log(`${c.name}\tskipped: openssl is missing`);
				if (values.gate) failed++;
				continue;
			}
			let sample: Sample;
			try {
				sample = await c.measure(ctx);
			} catch (error) {
				failed++;
				console.log(`${c.name}\tFAILED: ${error instanceof Error ? error.message : String(error)}`);
				continue;
			}
			results[c.name] = { ...sample, budget: c.budget, msBudget: c.msBudget };
			const over = !c.ungated && sample.peak > c.budget * MB;
			const slow = c.msBudget !== undefined && sample.ms > c.msBudget;
			if (over || slow) failed++;
			console.log(
				[
					c.name,
					fmt(sample.peak),
					fmt(sample.peak - floorBytes),
					sample.idle ? fmt(sample.idle) : "",
					sample.anon ? fmt(sample.anon) : "",
					sample.ms.toFixed(0),
					sample.p95 === undefined ? "" : sample.p95.toFixed(0),
					`${c.ungated ? "report only" : c.budget}${over ? " OVER" : ""}`,
					c.msBudget === undefined ? "" : `${c.msBudget}${slow ? " SLOW" : ""}`,
				].join("\t"),
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
