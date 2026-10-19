import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { DgCliError } from "@dg/common";
import {
	type DgPaths,
	ensurePrivateDir,
	readCappedStdin,
	resolveDgPaths,
	selfCommand,
	writeFileAtomic,
	writeStdout,
} from "@dg/common/node";
import type { Command } from "commander";
import { getPublicKey, nip19, SimplePool } from "nostr-tools";
import { fetchNew, type PhoneFriendPool, publish, subscribe, wrap } from "./chat";
import {
	appendInbox,
	loadOrCreateKey,
	type PhoneFriendConfig,
	readConfig,
	readSeen,
	writeConfig,
	writeSeen,
} from "./store";

export type PhoneFriendDeps = {
	paths: DgPaths;
	createPool: () => PhoneFriendPool & { close(relays: string[]): void };
	spawnListener: (paths: DgPaths) => number;
	isAlive: (pid: number) => boolean;
	kill: (pid: number) => void;
	write: (text: string) => void;
	sleep: (ms: number) => Promise<void>;
	readStdin: () => Promise<string | undefined>;
};

const FOLLOW_POLL_MS = 1000;
const STOP_WAIT_MS = 5000;
const MAX_SEND_BYTES = 64 * 1024;

function isOurListener(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	const cmdline = `/proc/${pid}/cmdline`;
	if (existsSync(cmdline)) {
		const args = readFileSync(cmdline, "utf8").split("\0");
		return args.includes("phone-friend") && args.includes("__run");
	}
	if (process.platform === "win32") return true;
	const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
	return ps.status === 0 && / phone-friend __run\b/.test(ps.stdout);
}

function defaultDeps(): PhoneFriendDeps {
	return {
		paths: resolveDgPaths(),
		createPool: () => new SimplePool({ enableReconnect: true }),
		spawnListener: (paths) => {
			ensurePrivateDir(paths.phoneFriendDir);
			const log = openSync(paths.phoneFriendLogPath, "a", 0o600);
			const [command, ...args] = selfCommand(["phone-friend", "__run"]);
			const child = spawn(command as string, args, {
				detached: true,
				stdio: ["ignore", log, log],
				windowsHide: true,
				env: process.env,
			});
			child.unref();
			if (child.pid === undefined) throw new DgCliError("could not spawn the phone-friend listener");
			return child.pid;
		},
		isAlive: isOurListener,
		kill: (pid) => process.kill(pid, "SIGTERM"),
		write: writeStdout,
		sleep: (ms) => Bun.sleep(ms),
		readStdin: () => readCappedStdin(MAX_SEND_BYTES),
	};
}

function printJson(deps: PhoneFriendDeps, value: unknown): void {
	deps.write(`${JSON.stringify(value)}\n`);
}

function contactHex(npub: string): string {
	try {
		const decoded = nip19.decode(npub);
		if (decoded.type === "npub") return decoded.data;
	} catch {}
	throw new DgCliError(`contact must be an npub, got "${npub}"`);
}

function requireContact(config: PhoneFriendConfig): string {
	if (!config.contact) {
		throw new DgCliError("no contact saved; run `dg-agent phone-friend on --contact <npub>` first");
	}
	return config.contact;
}

function readPid(paths: DgPaths): number | undefined {
	if (!existsSync(paths.phoneFriendPidPath)) return undefined;
	const pid = Number(readFileSync(paths.phoneFriendPidPath, "utf8").trim());
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function livePid(deps: PhoneFriendDeps): number | undefined {
	const pid = readPid(deps.paths);
	return pid !== undefined && deps.isAlive(pid) ? pid : undefined;
}

async function stopListener(pid: number, deps: PhoneFriendDeps): Promise<void> {
	deps.kill(pid);
	for (let waited = 0; deps.isAlive(pid) && waited < STOP_WAIT_MS; waited += 100) {
		await deps.sleep(100);
	}
	if (deps.isAlive(pid)) throw new DgCliError(`the phone-friend listener (pid ${pid}) did not stop`);
	rmSync(deps.paths.phoneFriendPidPath, { force: true });
}

function myNpub(deps: PhoneFriendDeps): string {
	return nip19.npubEncode(getPublicKey(loadOrCreateKey(deps.paths)));
}

export async function phoneNumber(deps: PhoneFriendDeps): Promise<void> {
	printJson(deps, {
		npub: myNpub(deps),
		contact: readConfig(deps.paths).contact ?? null,
		key_store: "file",
		listener: livePid(deps) ?? null,
	});
}

export async function phoneOn(
	opts: { contact?: string; relay?: string[] },
	deps: PhoneFriendDeps,
): Promise<void> {
	const saved = readConfig(deps.paths);
	const config = { ...saved };
	if (opts.contact) {
		contactHex(opts.contact);
		config.contact = opts.contact;
	}
	if (opts.relay?.length) config.relays = opts.relay;
	const npub = myNpub(deps);
	if (!config.contact) {
		throw new DgCliError(
			`no contact saved; your npub is ${npub}; run \`dg-agent phone-friend on --contact <npub>\``,
		);
	}
	const contact = config.contact;
	const changed = JSON.stringify(saved) !== JSON.stringify(config);
	const running = livePid(deps);
	if (running !== undefined && !changed) {
		printJson(deps, { npub, contact, pid: running, status: "running" });
		return;
	}
	if (running !== undefined) await stopListener(running, deps);
	writeConfig(deps.paths, config);
	const pid = deps.spawnListener(deps.paths);
	writeFileAtomic(deps.paths.phoneFriendPidPath, `${pid}\n`, 0o600);
	printJson(deps, { npub, contact, pid, status: running === undefined ? "started" : "restarted" });
}

export async function phoneOff(deps: PhoneFriendDeps): Promise<void> {
	const pid = livePid(deps);
	if (pid !== undefined) await stopListener(pid, deps);
	rmSync(deps.paths.phoneFriendPidPath, { force: true });
	printJson(deps, { pid: pid ?? null, status: "off" });
}

function printUnread(deps: PhoneFriendDeps): void {
	const { phoneFriendInboxPath, phoneFriendReadOffsetPath } = deps.paths;
	if (!existsSync(phoneFriendInboxPath)) return;
	const size = statSync(phoneFriendInboxPath).size;
	const saved = existsSync(phoneFriendReadOffsetPath)
		? Number(readFileSync(phoneFriendReadOffsetPath, "utf8"))
		: 0;
	const offset = Number.isInteger(saved) && saved >= 0 && saved <= size ? saved : 0;
	if (size === offset) return;
	const unread = Buffer.alloc(size - offset);
	const fd = openSync(phoneFriendInboxPath, "r");
	try {
		readSync(fd, unread, 0, unread.length, offset);
	} finally {
		closeSync(fd);
	}
	const end = unread.lastIndexOf(0x0a) + 1;
	if (end === 0) return;
	deps.write(unread.subarray(0, end).toString("utf8"));
	writeFileAtomic(phoneFriendReadOffsetPath, String(offset + end), 0o600);
}

export async function phoneAnswer(deps: PhoneFriendDeps): Promise<void> {
	if (livePid(deps) === undefined) {
		throw new DgCliError("the phone-friend listener is off; run `dg-agent phone-friend on`");
	}
	for (;;) {
		printUnread(deps);
		await deps.sleep(FOLLOW_POLL_MS);
		if (livePid(deps) === undefined) {
			printUnread(deps);
			throw new DgCliError("the phone-friend listener stopped");
		}
	}
}

export async function phoneVoicemail(deps: PhoneFriendDeps): Promise<void> {
	if (livePid(deps) === undefined) {
		const config = readConfig(deps.paths);
		const contact = contactHex(requireContact(config));
		const pool = deps.createPool();
		try {
			const { messages, seen } = await fetchNew(
				pool,
				config.relays,
				loadOrCreateKey(deps.paths),
				contact,
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

export async function phoneSay(text: string, deps: PhoneFriendDeps): Promise<void> {
	const config = readConfig(deps.paths);
	const contact = contactHex(requireContact(config));
	const body = text === "-" ? (await deps.readStdin())?.replace(/\n$/, "") : text;
	if (!body) throw new DgCliError("message text is empty");
	const event = wrap(body, loadOrCreateKey(deps.paths), contact);
	const pool = deps.createPool();
	try {
		const { ok } = await publish(pool, config.relays, event);
		if (ok.length === 0) throw new DgCliError("no relay accepted the message");
		printJson(deps, { id: event.id, relays_ok: ok });
	} finally {
		pool.close(config.relays);
	}
}

async function phoneRun(deps: PhoneFriendDeps): Promise<void> {
	const config = readConfig(deps.paths);
	const contact = contactHex(requireContact(config));
	const pool = deps.createPool();
	const sub = subscribe(
		pool,
		config.relays,
		loadOrCreateKey(deps.paths),
		contact,
		readSeen(deps.paths),
		(message, seen) => {
			appendInbox(deps.paths, message);
			writeSeen(deps.paths, seen);
		},
	);
	const shutdown = () => {
		sub.close();
		pool.close(config.relays);
		if (readPid(deps.paths) === process.pid) rmSync(deps.paths.phoneFriendPidPath, { force: true });
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	await new Promise(() => {});
}

export function registerPhoneFriendCommands(
	program: Command,
	makeDeps: () => PhoneFriendDeps = defaultDeps,
): void {
	const phone = program
		.command("phone-friend")
		.description("private NIP-17 chat with one contact over public Nostr relays");

	phone
		.command("number")
		.description("print your number (npub), your contact, and the listener state")
		.action(() => phoneNumber(makeDeps()));

	phone
		.command("on")
		.description("start the background listener")
		.option("--contact <npub>", "the one npub to chat with")
		.option("--relay <url...>", "relays to use instead of the defaults")
		.action((opts: { contact?: string; relay?: string[] }) => phoneOn(opts, makeDeps()));

	phone
		.command("off")
		.description("stop the background listener")
		.action(() => phoneOff(makeDeps()));

	phone
		.command("answer")
		.description("stay on the line: print new messages as JSON lines until the listener stops")
		.action(() => phoneAnswer(makeDeps()));

	phone
		.command("voicemail")
		.description("print unread messages as JSON lines, then exit")
		.action(() => phoneVoicemail(makeDeps()));

	phone
		.command("say")
		.description("send one message to your contact")
		.argument("<text>", "message text, or - to read it from stdin")
		.action((text: string) => phoneSay(text, makeDeps()));

	phone
		.command("__run", { hidden: true })
		.action(() => phoneRun(makeDeps()));
}
