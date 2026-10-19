import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { DgCliError } from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	resolveDgPaths,
	selfCommand,
	writeFileAtomic,
	writeStdout,
} from "@dg/common/node";
import type { Command } from "commander";
import { getPublicKey, nip19, SimplePool } from "nostr-tools";
import { fetchNew, type PhonePool, publish, subscribe, wrap } from "./chat";
import {
	appendInbox,
	loadOrCreateKey,
	type PhoneConfig,
	readConfig,
	readSeen,
	writeConfig,
	writeSeen,
} from "./store";

export type PhoneDeps = {
	paths: DgPaths;
	createPool: () => PhonePool & { close(relays: string[]): void };
	spawnListener: (paths: DgPaths) => number;
	isAlive: (pid: number) => boolean;
	kill: (pid: number) => void;
	write: (text: string) => void;
	sleep: (ms: number) => Promise<void>;
};

const FOLLOW_POLL_MS = 1000;

function defaultDeps(): PhoneDeps {
	return {
		paths: resolveDgPaths(),
		createPool: () => new SimplePool({ enableReconnect: true }),
		spawnListener: (paths) => {
			ensurePrivateDir(paths.phoneDir);
			const log = openSync(paths.phoneLogPath, "a", 0o600);
			const [command, ...args] = selfCommand(["phone", "__run"]);
			const child = spawn(command as string, args, {
				detached: true,
				stdio: ["ignore", log, log],
				windowsHide: true,
				env: process.env,
			});
			child.unref();
			if (child.pid === undefined) throw new DgCliError("could not spawn the phone listener");
			return child.pid;
		},
		isAlive: (pid) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		},
		kill: (pid) => process.kill(pid, "SIGTERM"),
		write: writeStdout,
		sleep: (ms) => Bun.sleep(ms),
	};
}

function printJson(deps: PhoneDeps, value: unknown): void {
	deps.write(`${JSON.stringify(value)}\n`);
}

function peerHex(npub: string): string {
	try {
		const decoded = nip19.decode(npub);
		if (decoded.type === "npub") return decoded.data;
	} catch {}
	throw new DgCliError(`peer must be an npub, got "${npub}"`);
}

function requirePeer(config: PhoneConfig): string {
	if (!config.peer) {
		throw new DgCliError("no peer saved; run `dg-agent phone start --peer <npub>` first");
	}
	return config.peer;
}

function readPid(paths: DgPaths): number | undefined {
	if (!existsSync(paths.phonePidPath)) return undefined;
	const pid = Number(readFileSync(paths.phonePidPath, "utf8").trim());
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function livePid(deps: PhoneDeps): number | undefined {
	const pid = readPid(deps.paths);
	return pid !== undefined && deps.isAlive(pid) ? pid : undefined;
}

export async function phoneStart(
	opts: { peer?: string; relay?: string[] },
	deps: PhoneDeps,
): Promise<void> {
	const config = readConfig(deps.paths);
	if (opts.peer) {
		peerHex(opts.peer);
		config.peer = opts.peer;
	}
	if (opts.relay?.length) config.relays = opts.relay;
	const npub = nip19.npubEncode(getPublicKey(loadOrCreateKey(deps.paths)));
	if (!config.peer) {
		throw new DgCliError(
			`no peer saved; your npub is ${npub}; run \`dg-agent phone start --peer <npub>\``,
		);
	}
	const peer = config.peer;
	writeConfig(deps.paths, config);
	const running = livePid(deps);
	if (running !== undefined) {
		printJson(deps, { npub, peer, pid: running, status: "running" });
		return;
	}
	const pid = deps.spawnListener(deps.paths);
	writeFileAtomic(deps.paths.phonePidPath, `${pid}\n`, 0o600);
	printJson(deps, { npub, peer, pid, status: "started" });
}

export async function phoneStop(deps: PhoneDeps): Promise<void> {
	const pid = livePid(deps);
	if (pid !== undefined) deps.kill(pid);
	rmSync(deps.paths.phonePidPath, { force: true });
	printJson(deps, { pid: pid ?? null, status: "stopped" });
}

function printUnread(deps: PhoneDeps): void {
	const { phoneInboxPath, phoneReadOffsetPath } = deps.paths;
	if (!existsSync(phoneInboxPath)) return;
	const inbox = readFileSync(phoneInboxPath);
	const saved = existsSync(phoneReadOffsetPath)
		? Number(readFileSync(phoneReadOffsetPath, "utf8"))
		: 0;
	const offset = Number.isInteger(saved) && saved <= inbox.length ? saved : 0;
	const end = inbox.lastIndexOf(0x0a) + 1;
	if (end <= offset) return;
	deps.write(inbox.subarray(offset, end).toString("utf8"));
	writeFileAtomic(phoneReadOffsetPath, String(end), 0o600);
}

export async function phoneListen(opts: { follow?: boolean }, deps: PhoneDeps): Promise<void> {
	if (opts.follow) {
		if (livePid(deps) === undefined) {
			throw new DgCliError("the phone listener is not running; run `dg-agent phone start`");
		}
		for (;;) {
			printUnread(deps);
			await deps.sleep(FOLLOW_POLL_MS);
			if (livePid(deps) === undefined) {
				printUnread(deps);
				throw new DgCliError("the phone listener stopped");
			}
		}
	}
	if (livePid(deps) === undefined) {
		const config = readConfig(deps.paths);
		const peer = peerHex(requirePeer(config));
		const pool = deps.createPool();
		try {
			const { messages, seen } = await fetchNew(
				pool,
				config.relays,
				loadOrCreateKey(deps.paths),
				peer,
				readSeen(deps.paths),
			);
			for (const message of messages) appendInbox(deps.paths, message);
			writeSeen(deps.paths, seen);
		} finally {
			pool.close(config.relays);
		}
	}
	printUnread(deps);
}

export async function phoneSend(text: string, deps: PhoneDeps): Promise<void> {
	const config = readConfig(deps.paths);
	const peer = peerHex(requirePeer(config));
	const event = wrap(text, loadOrCreateKey(deps.paths), peer);
	const pool = deps.createPool();
	try {
		const { ok } = await publish(pool, config.relays, event);
		if (ok.length === 0) throw new DgCliError("no relay accepted the message");
		printJson(deps, { id: event.id, relays_ok: ok });
	} finally {
		pool.close(config.relays);
	}
}

async function phoneRun(deps: PhoneDeps): Promise<void> {
	const config = readConfig(deps.paths);
	const peer = peerHex(requirePeer(config));
	const pool = deps.createPool();
	const sub = subscribe(
		pool,
		config.relays,
		loadOrCreateKey(deps.paths),
		peer,
		readSeen(deps.paths),
		(message, seen) => {
			appendInbox(deps.paths, message);
			writeSeen(deps.paths, seen);
		},
	);
	const shutdown = () => {
		sub.close();
		pool.close(config.relays);
		if (readPid(deps.paths) === process.pid) rmSync(deps.paths.phonePidPath, { force: true });
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	await new Promise(() => {});
}

export function registerPhoneCommands(
	program: Command,
	makeDeps: () => PhoneDeps = defaultDeps,
): void {
	const phone = program
		.command("phone")
		.description("private NIP-17 chat with one peer over public Nostr relays");

	phone
		.command("start")
		.description("save the peer and start the background listener; prints your npub")
		.option("--peer <npub>", "the one npub to chat with (required on first start)")
		.option("--relay <url...>", "relays to use instead of the defaults")
		.action((opts: { peer?: string; relay?: string[] }) => phoneStart(opts, makeDeps()));

	phone
		.command("stop")
		.description("stop the background listener")
		.action(() => phoneStop(makeDeps()));

	phone
		.command("listen")
		.description("print unread messages as JSON lines")
		.option("-f, --follow", "keep printing new messages from the running listener")
		.action((opts: { follow?: boolean }) => phoneListen(opts, makeDeps()));

	phone
		.command("send")
		.description("send one message to the peer")
		.argument("<text>", "message text")
		.action((text: string) => phoneSend(text, makeDeps()));

	phone
		.command("__run", { hidden: true })
		.action(() => phoneRun(makeDeps()));
}
