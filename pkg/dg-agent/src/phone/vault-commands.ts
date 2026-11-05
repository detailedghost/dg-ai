import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { killProcessTree, writeFileAtomic } from "@dg/common/node";
import type { PhoneDeps } from "./commands";
import type { VaultItemRow } from "./db";
import { imageFileName, type ImageType } from "./image";
import { findContactByNpub } from "./store";
import {
	assertVaultName,
	deleteVaultItem,
	dropOldKeys,
	ensureDayKey,
	localDay,
	MAX_VAULT_BYTES,
	openVaultItem,
	requireVaultStore,
	SELF_SENDER,
	storeVaultItem,
	VAULT_DIR,
} from "./vault";

/** The human's terminal, kept apart from stdout so an agent that pipes stdout never sees an item. */
export type Terminal = {
	/** True only when stdin and stdout are both TTYs. */
	interactive: boolean;
	env: Record<string, string | undefined>;
	write(text: string): void;
	/** Shows an image file and resolves once the human is done with it. */
	view(path: string): Promise<void>;
};

export type ExecOpts = { env?: string; stdin?: boolean; out?: string; timeout?: string };

export const EXEC_DEFAULT_TIMEOUT_S = 120;
const EXEC_MAX_TIMEOUT_S = 3600;
const EXIT_TIMED_OUT = 124;

const MAX_ENV_BYTES = 64 * 1024;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const IMAGE_TYPES: ReadonlySet<string> = new Set<ImageType>(["image/png", "image/jpeg", "image/webp"]);

function printJson(deps: PhoneDeps, value: unknown): void {
	deps.write(`${JSON.stringify(value)}\n`);
}

/** Refuses without the store, then expires old items and drops old day keys before any vault command. */
async function prepareVault(deps: PhoneDeps): Promise<void> {
	await requireVaultStore(deps);
	deps.db.pruneMessages();
	await dropOldKeys(deps, deps.now());
}

function liveItem(deps: PhoneDeps, name: string): VaultItemRow {
	const row = deps.db.vaultItem(assertVaultName(name));
	if (!row) throw new DgCliError(`no vault item ${name}`);
	return row;
}

function senderLabel(deps: PhoneDeps, sender: string): string {
	if (sender === SELF_SENDER) return SELF_SENDER;
	const contact = findContactByNpub(deps.db, sender);
	return contact ? `+${contact.handle}` : sender;
}

async function readInput(file: string | undefined, deps: PhoneDeps): Promise<Buffer> {
	const tooLarge = () => new DgCliError("vault item is larger than 5 MiB");
	let bytes: Buffer | undefined;
	if (file === undefined) {
		bytes = await deps.readStdinBytes?.(MAX_VAULT_BYTES);
	} else {
		const stat = statSync(file, { throwIfNoEntry: false });
		if (!stat?.isFile()) throw new DgCliError(`no file at ${file}`);
		if (stat.size > MAX_VAULT_BYTES) throw tooLarge();
		bytes = readFileSync(file);
	}
	if (!bytes || bytes.length > MAX_VAULT_BYTES) throw tooLarge();
	if (bytes.length === 0) throw new DgCliError("vault item is empty");
	return bytes;
}

async function todayKey(deps: PhoneDeps) {
	const day = localDay(deps.now());
	return { day, key: await ensureDayKey(deps, day) };
}

export async function phoneVaultAdd(name: string, file: string | undefined, deps: PhoneDeps): Promise<void> {
	assertVaultName(name);
	await prepareVault(deps);
	if (deps.db.vaultNameTaken(name)) throw new DgCliError(`vault item ${name} exists`);
	const plain = await readInput(file, deps);
	const row = storeVaultItem(deps.db, deps.paths.phoneRoot, { name, sender: SELF_SENDER, plain, key: await todayKey(deps) }, deps.now());
	printJson(deps, { name: row.name, size: row.size, created_at: row.created_at, expires_at: row.expires_at });
}

export async function phoneVaultList(deps: PhoneDeps): Promise<void> {
	await prepareVault(deps);
	for (const row of deps.db.listVaultItems()) {
		printJson(deps, {
			name: row.name,
			size: row.size,
			type: row.type,
			sender: senderLabel(deps, row.sender),
			created_at: row.created_at,
			expires_at: row.expires_at,
		});
	}
}

export async function phoneVaultRm(name: string, deps: PhoneDeps): Promise<void> {
	await prepareVault(deps);
	deleteVaultItem(deps.db, deps.paths.phoneRoot, liveItem(deps, name));
	printJson(deps, { removed: name });
}

/** Decrypts an item in memory for `text --vault`; only text and images can be sent. */
export async function readVaultForSend(name: string, deps: PhoneDeps): Promise<{ kind: "text"; text: string } | { kind: "image"; plain: Buffer }> {
	await prepareVault(deps);
	const row = liveItem(deps, name);
	const plain = await openVaultItem(deps, deps.paths.phoneRoot, row);
	if (row.type === "text/plain") return { kind: "text", text: plain.toString("utf8") };
	if (IMAGE_TYPES.has(row.type)) return { kind: "image", plain };
	throw new DgCliError(`vault item ${name} is not text or an image`);
}

/** Markers that agent tools set in the shells and hooks they run, each confirmed from that tool's source or docs. */
const AGENT_ENV_NAMES: ReadonlySet<string> = new Set(["CLAUDECODE", "OPENCODE", "GEMINI_CLI", "GROK_HOOK_EVENT"]);
const AGENT_ENV_PREFIXES = ["CLAUDE_CODE_", "CODEX_"];

function agentSession(env: Record<string, string | undefined>): boolean {
	return Object.entries(env).some(
		([name, value]) => value !== undefined && value !== "" && (AGENT_ENV_NAMES.has(name) || AGENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))),
	);
}

/** Human only: shows text on the terminal and an image through a viewer copy that is deleted afterward. */
export async function phoneVaultOpen(name: string, deps: PhoneDeps): Promise<void> {
	const terminal = deps.terminal;
	if (!terminal || agentSession(terminal.env)) throw new DgCliError("vault open is for a human at a terminal, and an agent session is running here");
	if (!terminal.interactive) throw new DgCliError("vault open needs an interactive terminal on stdin and stdout");
	await prepareVault(deps);
	const row = liveItem(deps, name);
	const plain = await openVaultItem(deps, deps.paths.phoneRoot, row);
	if (row.type === "text/plain") {
		const text = plain.toString("utf8");
		terminal.write(text.endsWith("\n") ? text : `${text}\n`);
		return;
	}
	if (!IMAGE_TYPES.has(row.type)) throw new DgCliError(`vault item ${name} is not text or an image`);
	const id = randomBytes(16).toString("hex");
	const ext = imageFileName({ sha256: "0".repeat(64), type: row.type as ImageType })?.split(".").pop();
	const path = join(deps.paths.phoneRoot, VAULT_DIR, `${id}.view.${ext}`);
	try {
		writeFileAtomic(path, plain, 0o600);
		await terminal.view(path);
	} finally {
		rmSync(path, { force: true });
	}
}

const DROPPED_ENV_PREFIXES = ["DG_", "AWS_", "AZURE_", "ARM_", "CLOUDSDK_", "GOOGLE_"];
const DROPPED_ENV_NAMES: ReadonlySet<string> = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

/** The parent env without dg session, grant, and home variables or known cloud credentials. */
function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const kept: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined || DROPPED_ENV_NAMES.has(name) || DROPPED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		kept[name] = value;
	}
	return kept;
}

type ChildResult = { code: number | null; stdout?: Buffer; size: number; stderrLines: number; failedToStart: boolean; timedOut: boolean };

function runChild(argv: string[], input: { stdin?: Buffer; env?: Record<string, string> }, timeoutMs: number): Promise<ChildResult> {
	return new Promise((resolve) => {
		const child = spawn(argv[0]!, argv.slice(1), {
			shell: false,
			windowsHide: true,
			detached: process.platform !== "win32",
			env: { ...childEnv(process.env), ...input.env },
			stdio: [input.stdin ? "pipe" : "ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let over = false;
		let newlines = 0;
		let partial = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (over) return;
			if (size > MAX_VAULT_BYTES) {
				over = true;
				chunks.length = 0;
				if (child.pid !== undefined) killProcessTree(child.pid);
				return;
			}
			chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			for (const byte of chunk) if (byte === 0x0a) newlines += 1;
			partial = chunk[chunk.length - 1] !== 0x0a;
		});
		if (input.stdin && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(input.stdin);
		}
		let started = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) killProcessTree(child.pid);
		}, timeoutMs);
		child.once("spawn", () => {
			started = true;
		});
		child.once("error", () => {
			if (started) return;
			clearTimeout(timer);
			resolve({ code: null, size: 0, stderrLines: 0, failedToStart: true, timedOut: false });
		});
		child.once("close", (code: number | null) => {
			clearTimeout(timer);
			resolve({
				timedOut,
				code,
				stdout: over ? undefined : Buffer.concat(chunks),
				size,
				stderrLines: newlines + (partial ? 1 : 0),
				failedToStart: !started,
			});
		});
	});
}

function envInput(name: string, row: VaultItemRow, plain: Buffer): Record<string, string> {
	if (!ENV_NAME_PATTERN.test(name)) throw new DgCliError(`--env takes a name that matches ^[A-Z_][A-Z0-9_]*$, got "${name}"`);
	if (row.type !== "text/plain" || plain.includes(0) || plain.length >= MAX_ENV_BYTES) {
		throw new DgCliError("--env takes only a text item under 64 KiB with no NUL byte; use --stdin");
	}
	return { [name]: plain.toString("utf8") };
}

/** Runs `argv` with the item on stdin or in one env var and seals its stdout into a new item. */
export async function phoneVaultExec(name: string, argv: string[], opts: ExecOpts, deps: PhoneDeps): Promise<void> {
	if (opts.env !== undefined && opts.stdin) throw new DgCliError("--env and --stdin cannot be used together");
	if (argv.length === 0) throw new DgCliError("vault exec needs a command after --");
	const outName = assertVaultName(opts.out ?? `${name}-out`);
	const seconds = opts.timeout === undefined ? EXEC_DEFAULT_TIMEOUT_S : Number(opts.timeout);
	if (!Number.isFinite(seconds) || seconds < 1 || seconds > EXEC_MAX_TIMEOUT_S) {
		throw new DgCliError(`--timeout must be a number of seconds from 1 to ${EXEC_MAX_TIMEOUT_S}, got "${opts.timeout}"`);
	}
	await prepareVault(deps);
	const row = liveItem(deps, name);
	if (deps.db.vaultNameTaken(outName)) throw new DgCliError(`vault item ${outName} exists; --out never overwrites`);
	const plain = await openVaultItem(deps, deps.paths.phoneRoot, row);
	const input = opts.env === undefined ? { stdin: plain } : { env: envInput(opts.env, row, plain) };
	const key = await todayKey(deps);
	const result = await runChild(argv, input, seconds * 1000);
	if (result.failedToStart) throw new DgCliError(`could not start ${argv[0]}`);
	if (result.timedOut) throw new DgCliError(`the command ran past ${seconds} s and was stopped, so no item was stored`, EXIT_TIMED_OUT);
	if (!result.stdout) throw new DgCliError("the command wrote more than 5 MiB to stdout, so no item was stored");
	const kept = result.code === 0;
	if (kept) storeVaultItem(deps.db, deps.paths.phoneRoot, { name: outName, sender: row.sender, plain: result.stdout, key }, deps.now());
	printJson(deps, { name, exit: result.code, out: kept ? outName : null, size: result.size, stderr_lines: result.stderrLines });
	if (!kept) throw new DgCliError(`the command exited ${result.code ?? "on a signal"}, so no item was stored`, result.code || 1);
}

/** Writes to the controlling terminal, never to stdout. */
export function writeTty(text: string): void {
	const fd = openSync(process.platform === "win32" ? "CONOUT$" : "/dev/tty", "w");
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
}

function viewerArgv(path: string): string[] {
	if (process.platform === "darwin") return ["open", "-W", path];
	if (process.platform === "win32") return ["cmd", "/c", "start", "/wait", "", path];
	return ["xdg-open", path];
}

/** Opens the system viewer, waits for it, then waits for Enter, since xdg-open returns before the viewer closes. */
async function viewImage(path: string): Promise<void> {
	const [command, ...args] = viewerArgv(path);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command!, args, { stdio: "ignore", shell: false, windowsHide: true });
		child.once("error", () => reject(new DgCliError(`could not start ${command}`)));
		child.once("close", () => resolve());
	});
	writeTty("press Enter when you are done viewing; the view copy is then deleted\n");
	await new Promise<void>((resolve) => {
		process.stdin.once("data", () => resolve());
		process.stdin.resume();
	});
	process.stdin.pause();
}

export function defaultTerminal(): Terminal {
	return {
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
		env: process.env,
		write: writeTty,
		view: viewImage,
	};
}
