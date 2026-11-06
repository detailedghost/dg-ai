import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import type { ProgramName } from "@dg/common/node/program";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { writeLegacyLine } from "../../dg-agent/__tests__/phone/legacy-line-fixture";
import { PhoneDb } from "../../dg-agent/src/phone/db";
import { bundleCommand } from "./bundle-build";
import { onTestRunEnd } from "./test-run-end";

export const FIXTURE_IDENTITY = "fixture-agent";

const POLL_MS = 50;
const SERVE_BOOT_CAP_MS = 20_000;
const SERVE_STOP_CAP_MS = 10_000;
const PROGRAM_CAP_MS = 60_000;
const ROLE_FOLDERS = ["bin", "config", "data", "state", "cache", "log"];
const NPUB = /npub1[023456789acdefghjklmnpqrstuvwxyz]+/;

export type ProgramRun = { code: number; stdout: string; stderr: string };

export type FixtureRows = { memoryId: string; token: string; npub: string };

export type ServeRun = { code: number; port: number; pidFile: string; pidFileGone: boolean; stderr: string };

export type PhoneFriendRows = FixtureRows & { contactNpub: string };

export type LegacyOptions = { fakeLiveDaemon?: boolean; fakeLiveListener?: boolean };

type Template = { dir: string; rows: FixtureRows };

const sleepers: number[] = [];
const roots: string[] = [];
let template: Template | undefined;

function fail(message: string): never {
	throw new Error(`fixture: ${message}`);
}

function removeRoots(): void {
	for (const pid of sleepers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

process.once("exit", removeRoots);
onTestRunEnd(removeRoots);

export function stopFixtureSleepers(): void {
	for (const pid of sleepers.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

function tempRoot(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(done: () => boolean, capMs: number): Promise<boolean> {
	const deadline = Date.now() + capMs;
	while (Date.now() < deadline) {
		if (done()) return true;
		await sleep(POLL_MS);
	}
	return done();
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function pidFrom(file: string): number | undefined {
	try {
		const text = readFileSync(file, "utf8").trim();
		const pid = Number(text.startsWith("{") ? (JSON.parse(text) as { pid?: unknown }).pid : text);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

function ephemeralPort(): number {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const { port } = probe;
	probe.stop(true);
	return port;
}

export function perOsPaths(home: string): DgPaths {
	return resolveDgPaths({ platform: process.platform, homeDir: home, env: {} });
}

/** Child env with no `DG_HOME` and no `XDG_*`, so every path resolves from `HOME`. */
export function spawnEnv(home: string): Record<string, string> {
	const env: Record<string, string> = { HOME: home, DG_KEY_SOURCE: "file" };
	if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
	if (process.env.TMPDIR !== undefined) env.TMPDIR = process.env.TMPDIR;
	return env;
}

async function run(env: Record<string, string>, cwd: string, program: ProgramName, args: string[]): Promise<ProgramRun> {
	const child = Bun.spawn([...bundleCommand(program), ...args], {
		env,
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), PROGRAM_CAP_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
	}
}

export function runProgram(home: string, program: ProgramName, args: string[]): Promise<ProgramRun> {
	return run(spawnEnv(home), home, program, args);
}

async function serve(env: Record<string, string>, cwd: string, pidFile: string): Promise<ServeRun> {
	const port = ephemeralPort();
	const child = Bun.spawn([...bundleCommand("dg-daemon"), "serve"], {
		env: { ...env, DG_PORT: String(port) },
		cwd,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	const stderr = new Response(child.stderr).text();
	const booted = await until(() => existsSync(pidFile), SERVE_BOOT_CAP_MS);
	child.kill("SIGTERM");
	const exited = await Promise.race([child.exited, sleep(SERVE_STOP_CAP_MS).then(() => undefined)]);
	if (exited === undefined) child.kill("SIGKILL");
	const code = exited ?? (await child.exited);
	if (!booted) fail(`dg-daemon serve wrote no pid file at ${pidFile}: ${await stderr}`);
	return { code, port, pidFile, pidFileGone: !existsSync(pidFile), stderr: await stderr };
}

export function serveUntilPidFile(home: string): Promise<ServeRun> {
	return serve(spawnEnv(home), home, perOsPaths(home).pidPath);
}

export function precreatePhoneRoot(home: string, mode: "unused" | "used"): void {
	const { phoneRoot } = perOsPaths(home);
	const db = PhoneDb.openAt(join(phoneRoot, "phone.db"), phoneRoot);
	try {
		if (mode === "used") db.putKey({ id: "precreated", nsec: "precreated-secret", in_store: 0 });
	} finally {
		db.close();
	}
}

export function phoneKeyIds(dbFile: string): string[] {
	const db = new Database(dbFile, { readonly: true });
	try {
		return (db.query("SELECT id FROM keys ORDER BY id").all() as { id: string }[]).map((row) => row.id);
	} finally {
		db.close();
	}
}

function copyInto(from: string, to: string): void {
	if (!existsSync(from)) fail(`the generated tree has no ${from}`);
	cpSync(from, to, { recursive: true });
}

function dropRuntimeFiles(dir: string): void {
	for (const name of readdirSync(dir, { recursive: true, encoding: "utf8" }))
		if (/\.(pid|lock)$/.test(name) || name.includes(".install.lock")) rmSync(join(dir, name), { force: true });
}

async function generateTemplate(): Promise<Template> {
	const base = tempRoot("dg-legacy-template-");
	const generatorHome = join(base, "generator-home");
	const flat = join(base, "flat", ".dg");
	mkdirSync(generatorHome, { recursive: true });
	mkdirSync(flat, { recursive: true });
	const env = { ...spawnEnv(generatorHome), DG_HOME: flat };
	const state = join(flat, "state");
	const served = await serve(env, generatorHome, join(state, "daemon", "daemon.pid"));
	if (served.code !== 0 && served.code !== 143 && served.code !== 128 + 15) fail(`dg-daemon serve exited ${served.code}: ${served.stderr}`);
	const token = `fixture-token-${crypto.randomUUID()}`;
	const written = await run(env, generatorHome, "dg-agent", ["memory", "write", "fixture note", token, "--identity", FIXTURE_IDENTITY]);
	if (written.code !== 0) fail(`memory write exited ${written.code}: ${written.stderr}`);
	const memoryId = written.stdout.trim();
	const phone = await run(env, generatorHome, "dg-agent", ["phone", "number"]);
	const npub = NPUB.exec(phone.stdout)?.[0];
	if (phone.code !== 0 || npub === undefined) fail(`phone number exited ${phone.code} with no npub: ${phone.stderr}`);
	const listenerPid = pidFrom(join(state, "phone", "listener.pid"));
	if (listenerPid !== undefined && alive(listenerPid)) fail(`a listener from phone number is alive: pid ${listenerPid}`);

	const legacy = join(base, "template", ".dg");
	mkdirSync(join(legacy, "agents"), { recursive: true });
	copyInto(join(state, "daemon"), join(legacy, "daemon"));
	copyInto(join(state, "phone"), join(legacy, "phone"));
	for (const name of readdirSync(join(state, "agents")))
		if (name.startsWith("memory.db") || name === "sessions" || name === "assets") copyInto(join(state, "agents", name), join(legacy, "agents", name));
	writeFileSync(join(legacy, "config.json"), `${JSON.stringify({ fixture: true })}\n`);
	mkdirSync(join(legacy, "grants"), { recursive: true });
	writeFileSync(join(legacy, "grants", "fixture.json"), `${JSON.stringify({ fixture: true })}\n`);
	for (const role of ROLE_FOLDERS) rmSync(join(legacy, role), { recursive: true, force: true });
	dropRuntimeFiles(legacy);

	const expected = ["daemon/daemon.db", "agents/memory.db", "phone/phone.db", "config.json", "grants/fixture.json"];
	for (const path of expected) if (!existsSync(join(legacy, path))) fail(`the legacy tree lacks ${path}`);
	const stray = readdirSync(legacy).filter((name) => ROLE_FOLDERS.includes(name));
	if (stray.length > 0) fail(`the legacy tree still holds role folders: ${stray.join(", ")}`);
	return { dir: legacy, rows: { memoryId, token, npub } };
}

function writeSleeperPid(file: string): void {
	const sleeper = Bun.spawn(["sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	sleeper.unref();
	sleepers.push(sleeper.pid);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${JSON.stringify({ pid: sleeper.pid, port: ephemeralPort() })}\n`);
}

/** Copies the once-per-run legacy tree to `<home>/.dg` and returns the rows it holds. */
export async function legacyHomeFixture(home: string, options: LegacyOptions = {}): Promise<FixtureRows> {
	template ??= await generateTemplate();
	const legacy = join(home, ".dg");
	mkdirSync(home, { recursive: true });
	cpSync(template.dir, legacy, { recursive: true });
	if (options.fakeLiveDaemon) writeSleeperPid(join(legacy, "daemon", "daemon.pid"));
	if (options.fakeLiveListener) writeSleeperPid(join(legacy, "phone", "listener.pid"));
	return template.rows;
}

export function fixtureHome(): string {
	return tempRoot("dg-layout-home-");
}

/** Extends `legacyHomeFixture`: removes its `phone/` folder, since a `phone.db` would suppress the conversion, and adds one phone-friend line whose `default` key is the number key. `npub` is that key's. */
export async function legacyPhoneFriendFixture(home: string): Promise<PhoneFriendRows> {
	const rows = await legacyHomeFixture(home);
	const legacy = join(home, ".dg");
	rmSync(join(legacy, "phone"), { recursive: true, force: true });
	const secret = generateSecretKey();
	const contactNpub = nip19.npubEncode(getPublicKey(generateSecretKey()));
	writeLegacyLine({ phoneFriendRoot: join(legacy, "phone-friend") }, "default", { contact: contactNpub, nsec: nip19.nsecEncode(secret) });
	return { ...rows, npub: nip19.npubEncode(getPublicKey(secret)), contactNpub };
}
