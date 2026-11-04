import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import {
	ensureWormhole,
	formatWormholeBytes,
	WORMHOLE_CODE_PATTERN,
	WORMHOLE_PINS,
	wormholeAsset,
	wormholeCode,
	wormholeReceive,
	wormholeSend,
	type WormholeDeps,
} from "../../src/phone/wormhole";
import { fakeWormhole } from "./fake-wormhole";

let home: string;
let paths: DgPaths;

function sha(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function toolPath(): string {
	return join(paths.phoneRoot, "tools", "wormhole-william-1.0.8-linux-amd64");
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function stage(rendezvous: string, code: string, data: Buffer, name: string): void {
	writeFileSync(join(rendezvous, `${code}.name`), name);
	writeFileSync(join(rendezvous, code), data);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-phone-wormhole-"));
	paths = resolveDgPaths({ env: { DG_HOME: home } });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("wormholeAsset", () => {
	it("maps each supported platform to its pinned release asset", () => {
		expect(wormholeAsset("linux", "x64")).toBe("wormhole-william-linux-amd64");
		expect(wormholeAsset("linux", "arm64")).toBe("wormhole-william-linux-arm64");
		expect(wormholeAsset("darwin", "x64")).toBe("wormhole-william-darwin-amd64");
		expect(wormholeAsset("darwin", "arm64")).toBe("wormhole-william-darwin-arm64");
		expect(wormholeAsset("win32", "x64")).toBe("wormhole-william-windows-amd64.exe");
		expect(wormholeAsset("win32", "arm64")).toBe("wormhole-william-windows-arm64.exe");
		for (const asset of [
			"wormhole-william-linux-amd64",
			"wormhole-william-linux-arm64",
			"wormhole-william-darwin-amd64",
			"wormhole-william-darwin-arm64",
			"wormhole-william-windows-amd64.exe",
			"wormhole-william-windows-arm64.exe",
		]) {
			expect(WORMHOLE_PINS[asset]).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("pins all 12 release assets", () => {
		expect(Object.keys(WORMHOLE_PINS)).toHaveLength(12);
	});

	it("refuses arm and an unknown os or arch", () => {
		expect(() => wormholeAsset("linux", "arm")).toThrow("wormhole is not available on linux-arm");
		expect(() => wormholeAsset("sunos", "x64")).toThrow("wormhole is not available on sunos-x64");
		expect(() => wormholeAsset("linux", "riscv64")).toThrow("wormhole is not available on linux-riscv64");
	});
});

describe("ensureWormhole", () => {
	it("downloads the pinned asset into tools/ under a versioned name with mode 0700", async () => {
		const fake = fakeWormhole(home);
		const urls: string[] = [];
		const path = await ensureWormhole(paths, {
			...fake.deps,
			fetch: async (url) => {
				urls.push(url);
				return new Response(fake.script);
			},
		});
		expect(path).toBe(toolPath());
		expect(urls).toEqual(["https://github.com/psanford/wormhole-william/releases/download/v1.0.8/wormhole-william-linux-amd64"]);
		expect(statSync(path).mode & 0o777).toBe(0o700);
		expect(statSync(join(paths.phoneRoot, "tools")).mode & 0o777).toBe(0o700);
		expect(sha(readFileSync(path))).toBe(fake.sha256);
		expect(readdirSync(join(paths.phoneRoot, "tools"))).toEqual(["wormhole-william-1.0.8-linux-amd64"]);
	});

	it("names the Windows binary with .exe", async () => {
		const fake = fakeWormhole(home);
		const path = await ensureWormhole(paths, {
			...fake.deps,
			platform: "win32",
			arch: "x64",
			pins: { "wormhole-william-windows-amd64.exe": fake.sha256 },
		});
		expect(path).toBe(join(paths.phoneRoot, "tools", "wormhole-william-1.0.8-windows-amd64.exe"));
	});

	it("refuses a download whose hash differs from the pin and leaves nothing in tools/", async () => {
		const fake = fakeWormhole(home);
		await expect(ensureWormhole(paths, { ...fake.deps, fetch: async () => new Response("tampered") })).rejects.toThrow(
			"wormhole download failed its hash check",
		);
		expect(readdirSync(join(paths.phoneRoot, "tools"))).toEqual([]);
	});

	it("refuses an unknown os or arch before any download", async () => {
		const fake = fakeWormhole(home);
		let fetched = false;
		const deps: WormholeDeps = {
			...fake.deps,
			arch: "arm",
			fetch: async () => {
				fetched = true;
				return new Response(fake.script);
			},
		};
		await expect(ensureWormhole(paths, deps)).rejects.toThrow("wormhole is not available on linux-arm");
		expect(fetched).toBe(false);
	});

	it("stops a download over 20 MiB", async () => {
		const fake = fakeWormhole(home);
		const big = new ReadableStream<Uint8Array>({
			start(controller) {
				for (let index = 0; index < 21; index += 1) controller.enqueue(new Uint8Array(1024 * 1024));
				controller.close();
			},
		});
		await expect(ensureWormhole(paths, { ...fake.deps, fetch: async () => new Response(big) })).rejects.toThrow(
			"wormhole download is larger than 20 MiB",
		);
		expect(readdirSync(join(paths.phoneRoot, "tools"))).toEqual([]);
	});

	it("follows an https redirect and refuses a plain http one", async () => {
		const fake = fakeWormhole(home);
		const seen: string[] = [];
		const path = await ensureWormhole(paths, {
			...fake.deps,
			fetch: async (url) => {
				seen.push(url);
				if (url.startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: "https://objects.example/blob" } });
				return new Response(fake.script);
			},
		});
		expect(path).toBe(toolPath());
		expect(seen[1]).toBe("https://objects.example/blob");
		rmSync(path);
		await expect(
			ensureWormhole(paths, {
				...fake.deps,
				fetch: async (url) =>
					url.startsWith("https://github.com/")
						? new Response(null, { status: 302, headers: { location: "http://objects.example/blob" } })
						: new Response(fake.script),
			}),
		).rejects.toThrow("wormhole download failed");
		expect(existsSync(path)).toBe(false);
	});

	it("rehashes an installed binary and replaces one that changed", async () => {
		const fake = fakeWormhole(home);
		let fetches = 0;
		const deps: WormholeDeps = {
			...fake.deps,
			fetch: async () => {
				fetches += 1;
				return new Response(fake.script);
			},
		};
		const path = await ensureWormhole(paths, deps);
		await ensureWormhole(paths, deps);
		expect(fetches).toBe(1);
		writeFileSync(path, "#!/bin/sh\nexit 0\n");
		await ensureWormhole(paths, deps);
		expect(fetches).toBe(2);
		expect(sha(readFileSync(path))).toBe(fake.sha256);
	});

	it("replaces a symlink at the tool path instead of running its target", async () => {
		const fake = fakeWormhole(home);
		await ensureWormhole(paths, fake.deps);
		const target = join(home, "elsewhere");
		writeFileSync(target, fake.script);
		rmSync(toolPath());
		symlinkSync(target, toolPath());
		await ensureWormhole(paths, fake.deps);
		expect(lstatSync(toolPath()).isSymbolicLink()).toBe(false);
	});
});

describe("wormholeCode", () => {
	it("makes 8 digits, a dash, and base32 of 16 random bytes, fresh every call", () => {
		const codes = new Set(Array.from({ length: 50 }, () => wormholeCode()));
		expect(codes.size).toBe(50);
		for (const code of codes) {
			expect(code).toMatch(/^[0-9]{8}-[a-z2-7]{26}$/);
			expect(code).toMatch(WORMHOLE_CODE_PATTERN);
		}
	});

	it("accepts only the format the sender checks", () => {
		expect(WORMHOLE_CODE_PATTERN.test("7-crossover-clockwork")).toBe(false);
		expect(WORMHOLE_CODE_PATTERN.test(`12345678-${"a".repeat(19)}`)).toBe(false);
		expect(WORMHOLE_CODE_PATTERN.test(`12345678-${"a".repeat(41)}`)).toBe(false);
		expect(WORMHOLE_CODE_PATTERN.test(`${"1".repeat(17)}-${"a".repeat(26)}`)).toBe(false);
		expect(WORMHOLE_CODE_PATTERN.test(`12345678-${"A".repeat(26)}`)).toBe(false);
		expect(WORMHOLE_CODE_PATTERN.test(`12345678-${"a".repeat(26)}`)).toBe(true);
	});
});

describe("formatWormholeBytes", () => {
	it("prints sizes the way the receive prompt does", () => {
		expect(formatWormholeBytes(999)).toBe("999 B");
		expect(formatWormholeBytes(1000)).toBe("1.0 kB");
		expect(formatWormholeBytes(1_234_567)).toBe("1.2 MB");
		expect(formatWormholeBytes(5 * 1024 * 1024 + 16)).toBe("5.2 MB");
	});

	it("rounds an exact tie to even and a near tie by its binary value, like Go", () => {
		expect(formatWormholeBytes(1250)).toBe("1.2 kB");
		expect(formatWormholeBytes(1750)).toBe("1.8 kB");
		expect(formatWormholeBytes(1_250_000)).toBe("1.2 MB");
		expect(formatWormholeBytes(1_150_000)).toBe("1.1 MB");
		expect(formatWormholeBytes(1_350_000)).toBe("1.4 MB");
	});
});

describe("wormholeReceive", () => {
	const cipher = randomBytes(3000);
	const x = sha(cipher);

	it("returns the file when the offer names x with the size tag, and removes its temp dir", async () => {
		const fake = fakeWormhole(home);
		const code = wormholeCode();
		stage(fake.rendezvous, code, cipher, x);
		const result = await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps);
		expect(result).toEqual({ ok: true, cipher });
		const [run] = fake.runs();
		expect(run?.answer).toBe("y");
		expect(existsSync(run?.cwd ?? "")).toBe(false);
	});

	it("passes the code on stdin, never in argv, and runs in a fresh 0700 dir with a minimal env", async () => {
		process.env.DG_SESSION_TEST_SECRET = "leak";
		try {
			const fake = fakeWormhole(home);
			const spawned: { command: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
			const code = wormholeCode();
			stage(fake.rendezvous, code, cipher, x);
			const result = await wormholeReceive(paths, { code, x, size: cipher.length }, {
				...fake.deps,
				spawn: (command, args, options) => {
					spawned.push({ command, args, options: options as Record<string, unknown> });
					return spawn(command, args, options);
				},
			});
			expect(result.ok).toBe(true);
			expect(spawned).toHaveLength(1);
			expect(spawned[0]?.command).toBe(toolPath());
			expect(spawned[0]?.args).toEqual(["receive", "--hide-progress"]);
			expect(spawned[0]?.options).toMatchObject({ shell: false, windowsHide: true });
			const [run] = fake.runs();
			expect(run?.args).toEqual(["receive", "--hide-progress"]);
			expect(JSON.stringify(run?.args)).not.toContain(code);
			expect(run?.env).toEqual({});
			expect(run?.cwd.startsWith(tmpdir())).toBe(true);
		} finally {
			delete process.env.DG_SESSION_TEST_SECRET;
		}
	});

	it("answers n when the offered name is not x", async () => {
		const fake = fakeWormhole(home, { receive: "wrong-name" });
		const code = wormholeCode();
		stage(fake.rendezvous, code, cipher, x);
		expect(await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps)).toEqual({ ok: false, reason: "bad offer" });
		expect(fake.runs()[0]?.answer).toBe("n");
	});

	it("answers n when the offered size is not the size tag", async () => {
		const fake = fakeWormhole(home, { receive: "wrong-size" });
		const code = wormholeCode();
		stage(fake.rendezvous, code, cipher, x);
		expect(await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps)).toEqual({ ok: false, reason: "bad offer" });
		expect(fake.runs()[0]?.answer).toBe("n");
	});

	it("answers n to a directory offer", async () => {
		const fake = fakeWormhole(home, { receive: "dir" });
		const code = wormholeCode();
		stage(fake.rendezvous, code, cipher, x);
		expect(await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps)).toEqual({ ok: false, reason: "bad offer" });
		expect(fake.runs()[0]?.answer).toBe("n");
	});

	it("fails a text offer, which has no prompt", async () => {
		const fake = fakeWormhole(home, { receive: "text" });
		const code = wormholeCode();
		stage(fake.rendezvous, code, Buffer.from("hello"), x);
		expect(await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps)).toEqual({ ok: false, reason: "no transfer" });
	});

	it("rejects a symlink in place of the file, even one whose own size matches", async () => {
		const fake = fakeWormhole(home, { receive: "symlink" });
		const small = randomBytes(fake.rendezvous.length + 100);
		const code = wormholeCode();
		stage(fake.rendezvous, code, small, sha(small));
		expect(await wormholeReceive(paths, { code, x: sha(small), size: small.length }, fake.deps)).toEqual({ ok: false, reason: "bad file" });
	});

	it("rejects two files", async () => {
		const fake = fakeWormhole(home, { receive: "two-files" });
		const code = wormholeCode();
		stage(fake.rendezvous, code, cipher, x);
		expect(await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps)).toEqual({ ok: false, reason: "bad file" });
	});

	it("rejects a file whose sha256 is not x", async () => {
		const fake = fakeWormhole(home, { receive: "corrupt" });
		const code = wormholeCode();
		stage(fake.rendezvous, code, cipher, x);
		expect(await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps)).toEqual({ ok: false, reason: "bad file" });
	});

	it("kills the process tree once the temp dir grows past the size", async () => {
		const fake = fakeWormhole(home, { receive: "oversize", limits: { receiveMs: 8000 } });
		const code = wormholeCode();
		stage(fake.rendezvous, code, cipher, x);
		const started = Date.now();
		expect(await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps)).toEqual({ ok: false, reason: "too large" });
		expect(Date.now() - started).toBeLessThan(5000);
		const run = fake.runs()[0];
		expect(alive(run?.pid ?? 0)).toBe(false);
		expect(existsSync(run?.cwd ?? "")).toBe(false);
	});

	it("kills the process tree at the attempt deadline", async () => {
		const fake = fakeWormhole(home, { receive: "hang", limits: { receiveMs: 300 } });
		const result = await wormholeReceive(paths, { code: wormholeCode(), x, size: cipher.length }, fake.deps);
		expect(result).toEqual({ ok: false, reason: "timeout" });
		expect(alive(fake.runs()[0]?.pid ?? 0)).toBe(false);
	});

	it("kills the process when the caller aborts", async () => {
		const fake = fakeWormhole(home, { receive: "hang" });
		const controller = new AbortController();
		const pending = wormholeReceive(paths, { code: wormholeCode(), x, size: cipher.length }, fake.deps, controller.signal);
		for (let waited = 0; fake.runs().length === 0 && waited < 5000; waited += 20) await Bun.sleep(20);
		controller.abort();
		expect(await pending).toEqual({ ok: false, reason: "timeout" });
		expect(alive(fake.runs()[0]?.pid ?? 0)).toBe(false);
	});

	it("never runs a binary that changed after install", async () => {
		const fake = fakeWormhole(home);
		const path = await ensureWormhole(paths, fake.deps);
		const marker = join(home, "tampered-ran");
		writeFileSync(path, `#!/bin/sh\ntouch ${marker}\n`);
		const code = wormholeCode();
		stage(fake.rendezvous, code, cipher, x);
		const result = await wormholeReceive(paths, { code, x, size: cipher.length }, fake.deps);
		expect(result.ok).toBe(true);
		expect(existsSync(marker)).toBe(false);
	});

	it("reports tool unavailable when the loader refuses", async () => {
		const fake = fakeWormhole(home);
		const result = await wormholeReceive(paths, { code: wormholeCode(), x, size: cipher.length }, { ...fake.deps, arch: "arm" });
		expect(result).toEqual({ ok: false, reason: "tool unavailable" });
	});
});

describe("wormholeSend", () => {
	it("runs send with the code, --hide-progress, and the file as array args with a minimal env", async () => {
		process.env.AWS_SECRET_ACCESS_KEY = "leak";
		try {
			const fake = fakeWormhole(home);
			const file = join(home, "a".repeat(64));
			writeFileSync(file, "cipher");
			const spawned: { args: readonly string[]; options: Record<string, unknown> }[] = [];
			const code = wormholeCode();
			const result = await wormholeSend(paths, { code, file }, {
				...fake.deps,
				spawn: (command, args, options) => {
					spawned.push({ args, options: options as Record<string, unknown> });
					return spawn(command, args, options);
				},
			});
			expect(result).toBe("sent");
			expect(spawned[0]?.args).toEqual(["send", "--code", code, "--hide-progress", file]);
			expect(spawned[0]?.options).toMatchObject({ shell: false, windowsHide: true, env: {} });
			expect(fake.runs()[0]?.env).toEqual({});
			expect(readFileSync(join(fake.rendezvous, code), "utf8")).toBe("cipher");
		} finally {
			delete process.env.AWS_SECRET_ACCESS_KEY;
		}
	});

	it("kills the process tree at the send deadline", async () => {
		const fake = fakeWormhole(home, { send: "hang", limits: { sendMs: 300 } });
		const file = join(home, "b".repeat(64));
		writeFileSync(file, "cipher");
		expect(await wormholeSend(paths, { code: wormholeCode(), file }, fake.deps)).toBe("timeout");
		expect(alive(fake.runs()[0]?.pid ?? 0)).toBe(false);
	});
});
