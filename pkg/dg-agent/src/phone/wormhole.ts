import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions, type StdioOptions } from "node:child_process";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, killProcessTree } from "@dg/common/node";

export const WORMHOLE_VERSION = "1.0.8";

/** sha256 of every wormhole-william v1.0.8 release asset; `scripts/pin-wormhole.ts --check` re-downloads and compares. */
export const WORMHOLE_PINS: Readonly<Record<string, string>> = {
	"wormhole-william-darwin-amd64": "104db5d55bf08989bec53911cf66805806f5eb6133550a5046c6202741d60bdd",
	"wormhole-william-darwin-arm64": "2d1204a1cf6f3f73e16965b90aa6682cab28eae3d5411c4094a9b7e4b650a70c",
	"wormhole-william-freebsd-amd64": "8b4a3a9c8eca7d1f911832387ccf19c146e37032eeedb8b643a724c8140a5aad",
	"wormhole-william-linux-amd64": "a6e501a9f3555617d980d8de49fb2f91783c27cfd875cb42a1ac5cf8fc11205d",
	"wormhole-william-linux-arm5": "b1e889bcfe28b25c7170d0f0fe291344435a73dfd4311681bc36d6642db9a2e0",
	"wormhole-william-linux-arm6": "e2565b8f20cab5bf2b50d695356d01a27d2443115b5fafd87c238ffcbd90f084",
	"wormhole-william-linux-arm64": "d1b727288bda91463e35e0312c102d35a95c77eb638aa6567eb6f2cc6f2759e8",
	"wormhole-william-linux-arm7": "fafa84260572e00bc46d179b4857195c54ade365b7bf80669dc40dc8a6ab86ed",
	"wormhole-william-netbsd-amd64": "81ca17d38f9fe26569c45d997ee123993a1f0784fbe1576f7187175b5711bba6",
	"wormhole-william-windows-386.exe": "a924c37a8a255d6a1d4ae949bcec2c30502f5f08d268b06002f63b91384ac742",
	"wormhole-william-windows-amd64.exe": "3070dfb895630fc01b4deabeffc3574681bb63f1dbd82f959aa663a6e09891fe",
	"wormhole-william-windows-arm64.exe": "2576d9448ea07d8faef8ac506492f6aa07ae9a011c734554c1ff15992b5d5250",
};

export const WORMHOLE_RELEASE_URL = `https://github.com/psanford/wormhole-william/releases/download/v${WORMHOLE_VERSION}/`;

const PLATFORM_ASSETS: Readonly<Record<string, string>> = {
	"linux-x64": "wormhole-william-linux-amd64",
	"linux-arm64": "wormhole-william-linux-arm64",
	"darwin-x64": "wormhole-william-darwin-amd64",
	"darwin-arm64": "wormhole-william-darwin-arm64",
	"win32-x64": "wormhole-william-windows-amd64.exe",
	"win32-arm64": "wormhole-william-windows-arm64.exe",
};

/** The receiver's code: nameplate digits, a dash, then base32 of 16 random bytes. */
export const WORMHOLE_CODE_PATTERN = /^[0-9]{1,16}-[a-z2-7]{20,40}$/;

/** Folder under `phoneRoot` that holds the pinned binary; never on PATH. */
export const TOOLS_DIR = "tools";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 64 * 1024;
const CODE_PROMPT = "Enter receive wormhole code: ";
const OFFER_END = "ok? (y/N):";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export type WormholeLimits = { receiveMs: number; sendMs: number; pollMs: number };

const DEFAULT_LIMITS: WormholeLimits = { receiveMs: 120_000, sendMs: 90_000, pollMs: 1000 };

export type SpawnWormhole = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Seams for the download, the process runner, the platform, and the limits; production passes none. */
export type WormholeDeps = {
	fetch?: (url: string, init: RequestInit) => Promise<Response>;
	spawn?: SpawnWormhole;
	platform?: NodeJS.Platform | string;
	arch?: string;
	pins?: Readonly<Record<string, string>>;
	limits?: Partial<WormholeLimits>;
};

export type ReceiveFailure = "tool unavailable" | "timeout" | "bad offer" | "too large" | "bad file" | "no transfer";

export type ReceiveResult = { ok: true; cipher: Buffer } | { ok: false; reason: ReceiveFailure };

export type SendOutcome = "sent" | "failed" | "timeout";

function unavailable(platform: string, arch: string): DgCliError {
	return new DgCliError(`wormhole is not available on ${platform}-${arch}`);
}

function downloadFailed(): DgCliError {
	return new DgCliError("wormhole download failed");
}

export function wormholeAsset(platform: string, arch: string): string {
	const asset = PLATFORM_ASSETS[`${platform}-${arch}`];
	if (!asset) throw unavailable(platform, arch);
	return asset;
}

function sha256Hex(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function matchesPin(path: string, pin: string): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	return stat?.isFile() === true && sha256Hex(readFileSync(path)) === pin;
}

async function download(url: string, fetcher: NonNullable<WormholeDeps["fetch"]>, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
	let next = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
		if (!next.startsWith("https://")) throw downloadFailed();
		const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
		const response = await fetcher(next, { redirect: "manual", signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location) throw downloadFailed();
			next = new URL(location, next).toString();
			continue;
		}
		if (!response.ok || !response.body) throw downloadFailed();
		return response.body;
	}
	throw downloadFailed();
}

async function install(
	path: string,
	url: string,
	pin: string,
	fetcher: NonNullable<WormholeDeps["fetch"]>,
	windows: boolean,
	signal?: AbortSignal,
): Promise<void> {
	const body = await download(url, fetcher, signal);
	const part = `${path}.${randomBytes(8).toString("hex")}.part`;
	const fd = openSync(part, "wx", 0o600);
	try {
		const hash = createHash("sha256");
		let total = 0;
		try {
			const reader = body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				if (total > MAX_DOWNLOAD_BYTES) {
					await reader.cancel();
					throw new DgCliError("wormhole download is larger than 20 MiB");
				}
				hash.update(value);
				writeSync(fd, value);
			}
		} finally {
			closeSync(fd);
		}
		if (hash.digest("hex") !== pin) throw new DgCliError("wormhole download failed its hash check");
		if (!windows) chmodSync(part, 0o700);
		renameSync(part, path);
	} catch (err) {
		rmSync(part, { force: true });
		throw err;
	}
}

/** Returns the absolute path of the pinned binary, downloading it on first use; rehashes it on every call. */
export async function ensureWormhole(paths: DgPaths, deps: WormholeDeps = {}, signal?: AbortSignal): Promise<string> {
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const asset = wormholeAsset(platform, arch);
	const pin = (deps.pins ?? WORMHOLE_PINS)[asset];
	if (!pin) throw unavailable(platform, arch);
	const dir = resolve(paths.phoneRoot, TOOLS_DIR);
	ensurePrivateDir(dir);
	const path = join(dir, asset.replace("wormhole-william-", `wormhole-william-${WORMHOLE_VERSION}-`));
	if (matchesPin(path, pin)) return path;
	rmSync(path, { force: true });
	await install(path, `${WORMHOLE_RELEASE_URL}${asset}`, pin, deps.fetch ?? fetch, platform === "win32", signal);
	return path;
}

function base32(bytes: Buffer): string {
	let out = "";
	let value = 0;
	let bits = 0;
	for (const byte of bytes) {
		value = ((value << 8) | byte) & 0xffff;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
	return out;
}

/** A fresh code for one transfer; the receiver never reuses one. */
export function wormholeCode(): string {
	const digits = [randomInt(1, 10), ...Array.from({ length: 7 }, () => randomInt(10))].join("");
	return `${digits}-${base32(randomBytes(16))}`;
}

/** The size text the receive prompt prints: Go `%.1f`, which rounds an exact tie to even. */
export function formatWormholeBytes(bytes: number): string {
	if (bytes < 1000) return `${bytes} B`;
	let div = 1000;
	let exp = 0;
	for (let n = Math.floor(bytes / 1000); n >= 1000; n = Math.floor(n / 1000)) {
		div *= 1000;
		exp += 1;
	}
	const value = bytes / div;
	const unit = `${"kMGTPE"[exp]}B`;
	if (!Number.isInteger(value * 4) || (value * 4) % 2 === 0) return `${value.toFixed(1)} ${unit}`;
	let tenths = Math.floor(value * 10);
	if (tenths % 2 === 1) tenths += 1;
	return `${(tenths / 10).toFixed(1)} ${unit}`;
}

function minimalEnv(platform: string): Record<string, string> {
	if (platform !== "win32") return {};
	const env: Record<string, string> = {};
	for (const name of ["SystemRoot", "TEMP", "TMP"]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return env;
}

function spawnWormhole(deps: WormholeDeps, path: string, args: string[], cwd: string | undefined, stdio: StdioOptions): ChildProcess {
	const platform = deps.platform ?? process.platform;
	return (deps.spawn ?? nodeSpawn)(path, args, {
		cwd,
		env: minimalEnv(platform),
		stdio,
		shell: false,
		windowsHide: true,
		detached: platform !== "win32",
	});
}

function kill(child: ChildProcess): void {
	if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) killProcessTree(child.pid);
}

function exited(child: ChildProcess): Promise<number | null> {
	return new Promise((done) => {
		child.once("close", (code: number | null) => done(code));
		child.once("error", () => done(null));
	});
}

function limitsOf(deps: WormholeDeps): WormholeLimits {
	return { ...DEFAULT_LIMITS, ...deps.limits };
}

/** Runs `send --code <code> --hide-progress <file>`; output is discarded and the process tree dies at the deadline. */
export async function wormholeSend(paths: DgPaths, req: { code: string; file: string }, deps: WormholeDeps = {}, signal?: AbortSignal): Promise<SendOutcome> {
	let path: string;
	try {
		path = await ensureWormhole(paths, deps, signal);
	} catch {
		return "failed";
	}
	if (signal?.aborted) return "failed";
	const child = spawnWormhole(deps, path, ["send", "--code", req.code, "--hide-progress", req.file], undefined, "ignore");
	let timedOut = false;
	const stop = () => {
		timedOut = true;
		kill(child);
	};
	const timer = setTimeout(stop, limitsOf(deps).sendMs);
	signal?.addEventListener("abort", stop, { once: true });
	try {
		const code = await exited(child);
		if (timedOut) return "timeout";
		return code === 0 ? "sent" : "failed";
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", stop);
	}
}

/** Sum of the sizes of the entries directly in `dir`; a link counts as its own size. */
export function dirBytes(dir: string): number {
	let total = 0;
	for (const name of readdirSync(dir)) total += lstatSync(join(dir, name), { throwIfNoEntry: false })?.size ?? 0;
	return total;
}

function readReceived(dir: string, x: string, size: number): ReceiveResult {
	const names = readdirSync(dir);
	if (names.length !== 1 || names[0] !== x) return { ok: false, reason: "bad file" };
	const path = join(dir, x);
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size !== size) return { ok: false, reason: "bad file" };
	const cipher = readFileSync(path);
	if (cipher.length !== size || sha256Hex(cipher) !== x) return { ok: false, reason: "bad file" };
	return { ok: true, cipher };
}

/** One receive attempt in a fresh 0700 temp dir, with the code on stdin. */
export async function wormholeReceive(
	paths: DgPaths,
	req: { code: string; x: string; size: number },
	deps: WormholeDeps = {},
	signal?: AbortSignal,
): Promise<ReceiveResult> {
	let path: string;
	try {
		path = await ensureWormhole(paths, deps, signal);
	} catch {
		return { ok: false, reason: signal?.aborted ? "timeout" : "tool unavailable" };
	}
	if (signal?.aborted) return { ok: false, reason: "timeout" };
	const limits = limitsOf(deps);
	const dir = mkdtempSync(join(tmpdir(), "dg-wormhole-"));
	try {
		chmodSync(dir, 0o700);
		const child = spawnWormhole(deps, path, ["receive", "--hide-progress"], dir, ["pipe", "pipe", "ignore"]);
		let failure: ReceiveFailure | undefined;
		let offered = false;
		let output = "";
		const fail = (reason: ReceiveFailure) => {
			failure ??= reason;
			kill(child);
		};
		const expected = `${CODE_PROMPT}Receiving file (${formatWormholeBytes(req.size)}) into: ${req.x}\n${OFFER_END}`;
		child.stdin?.on("error", () => {});
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > MAX_OUTPUT_CHARS) return fail("bad offer");
			if (offered || !output.endsWith(OFFER_END)) return;
			offered = true;
			if (output === expected) {
				child.stdin?.write("y\n");
				return;
			}
			failure ??= "bad offer";
			child.stdin?.write("n\n");
		});
		child.stdin?.write(`${req.code}\n`);
		const poll = setInterval(() => {
			if (dirBytes(dir) > req.size) fail("too large");
		}, limits.pollMs);
		const deadline = setTimeout(() => fail("timeout"), limits.receiveMs);
		const abort = () => fail("timeout");
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		try {
			await exited(child);
		} finally {
			clearInterval(poll);
			clearTimeout(deadline);
			signal?.removeEventListener("abort", abort);
		}
		if (failure) return { ok: false, reason: failure };
		if (!offered) return { ok: false, reason: "no transfer" };
		return readReceived(dir, req.x, req.size);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
