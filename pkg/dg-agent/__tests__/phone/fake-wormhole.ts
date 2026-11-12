import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { WormholeDeps } from "../../src/phone/wormhole";

/** How the fake `receive` behaves once the sender's bytes arrive at the rendezvous folder. */
export type FakeReceiveMode =
	| "ok"
	| "wrong-name"
	| "wrong-size"
	| "dir"
	| "text"
	| "symlink"
	| "two-files"
	| "two-files-over"
	| "oversize"
	| "corrupt"
	| "hang";

/** How the fake `send` behaves: `ok` copies the file to the rendezvous folder, `hang` never exits. */
export type FakeSendMode = "ok" | "hang";

export type FakeWormhole = {
	deps: WormholeDeps;
	script: Uint8Array<ArrayBuffer>;
	sha256: string;
	rendezvous: string;
	logPath: string;
	/** One JSON line per run: argv, env, cwd, pid, and the receive answer when there was one. */
	runs: () => FakeRun[];
};

export type FakeRun = { args: string[]; env: Record<string, string>; cwd: string; pid: number; answer?: string };

/** The fake binary: a Bun script that rendezvouses through files instead of the wormhole relays. */
export function fakeWormholeScript(opts: { rendezvous: string; logPath: string; receive?: FakeReceiveMode; send?: FakeSendMode }): string {
	const config = JSON.stringify({ rv: opts.rendezvous, log: opts.logPath, receive: opts.receive ?? "ok", send: opts.send ?? "ok" });
	return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const C = ${config};
const args = process.argv.slice(2);
const record = { args, env: process.env, cwd: process.cwd(), pid: process.pid };
const log = (extra) => fs.appendFileSync(C.log, JSON.stringify({ ...record, ...extra }) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const formatBytes = (b) => {
	if (b < 1000) return b + " B";
	let div = 1000, exp = 0;
	for (let n = Math.floor(b / 1000); n >= 1000; n = Math.floor(n / 1000)) { div *= 1000; exp++; }
	return (b / div).toFixed(1) + " " + "kMGTPE"[exp] + "B";
};
let buffered = "";
const waiters = [];
process.stdin.on("data", (chunk) => {
	buffered += chunk.toString();
	while (waiters.length && buffered.includes("\\n")) {
		const at = buffered.indexOf("\\n");
		const line = buffered.slice(0, at);
		buffered = buffered.slice(at + 1);
		waiters.shift()(line);
	}
});
const readLine = () => new Promise((resolve) => {
	if (buffered.includes("\\n")) {
		const at = buffered.indexOf("\\n");
		const line = buffered.slice(0, at);
		buffered = buffered.slice(at + 1);
		resolve(line);
	} else waiters.push(resolve);
});
const forever = () => new Promise(() => setInterval(() => {}, 1000));
async function send() {
	log({});
	if (C.send === "hang") return forever();
	const code = args[args.indexOf("--code") + 1];
	const file = args[args.length - 1];
	fs.copyFileSync(file, path.join(C.rv, code + ".part"));
	fs.writeFileSync(path.join(C.rv, code + ".name"), path.basename(file));
	fs.renameSync(path.join(C.rv, code + ".part"), path.join(C.rv, code));
	process.exit(0);
}
async function receive() {
	process.stdout.write("Enter receive wormhole code: ");
	const code = (await readLine()).trim();
	if (C.receive === "hang") { log({}); return forever(); }
	const ready = path.join(C.rv, code);
	for (let waited = 0; !fs.existsSync(ready); waited += 20) {
		if (waited > 20000) { log({}); process.exit(1); }
		await sleep(20);
	}
	const data = fs.readFileSync(ready);
	let name = fs.readFileSync(ready + ".name", "utf8");
	let size = data.length;
	if (C.receive === "text") { process.stdout.write(data.toString("latin1") + "\\n"); log({}); process.exit(0); }
	if (C.receive === "wrong-name") name = "evil.png";
	if (C.receive === "wrong-size") size = data.length + 5000;
	if (C.receive === "dir") {
		process.stdout.write("Receiving directory (" + formatBytes(size) + ") into: " + name + "\\n1 files, " + formatBytes(size) + " (uncompressed)\\nok? (y/N):");
	} else {
		process.stdout.write("Receiving file (" + formatBytes(size) + ") into: " + name + "\\nok? (y/N):");
	}
	const answer = (await readLine()).trim();
	log({ answer });
	if (answer !== "y") { process.stderr.write("transfer rejected\\n"); process.exit(1); }
	const out = path.join(process.cwd(), name);
	if (C.receive === "symlink") { const real = C.rv + "/" + "p".repeat(Math.max(1, data.length - C.rv.length - 1)); fs.writeFileSync(real, data); fs.symlinkSync(real, out); process.exit(0); }
	if (C.receive === "two-files" || C.receive === "two-files-over") { fs.writeFileSync(out, data); fs.writeFileSync(out + ".extra", C.receive === "two-files" ? "" : "x"); process.exit(0); }
	if (C.receive === "corrupt") { const bad = Buffer.from(data); bad[0] ^= 0xff; fs.writeFileSync(out, bad); process.exit(0); }
	if (C.receive === "oversize") {
		const fd = fs.openSync(out + ".tmp123", "w");
		for (;;) { fs.writeSync(fd, Buffer.alloc(64 * 1024, 1)); await sleep(5); }
	}
	fs.writeFileSync(out, data);
	process.exit(0);
}
if (args[0] === "send") send();
else if (args[0] === "receive") receive();
else process.exit(2);
`;
}

/** Fake download host plus pins for one fake binary; every spawn runs the real script through the real loader. */
export function fakeWormhole(
	dir: string,
	opts: {
		receive?: FakeReceiveMode;
		send?: FakeSendMode;
		rendezvous?: string;
		limits?: WormholeDeps["limits"];
		spawn?: WormholeDeps["spawn"];
	} = {},
): FakeWormhole {
	const rendezvous = opts.rendezvous ?? join(dir, "rendezvous");
	mkdirSync(rendezvous, { recursive: true });
	const logPath = join(dir, `wormhole-runs-${Math.random().toString(16).slice(2)}.ndjson`);
	const script = new TextEncoder().encode(fakeWormholeScript({ rendezvous, logPath, receive: opts.receive, send: opts.send }));
	const sha256 = createHash("sha256").update(script).digest("hex");
	const deps: WormholeDeps = {
		platform: "linux",
		arch: "x64",
		pins: { "wormhole-william-linux-amd64": sha256 },
		fetch: async () => new Response(script),
		limits: { receiveMs: 10_000, sendMs: 10_000, pollMs: 20, ...opts.limits },
		...(opts.spawn ? { spawn: opts.spawn } : {}),
	};
	return {
		deps,
		script,
		sha256,
		rendezvous,
		logPath,
		runs: () => {
			try {
				return readFileSync(logPath, "utf8")
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as FakeRun);
			} catch {
				return [];
			}
		},
	};
}
