import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, openSync, readFileSync, rmSync } from "node:fs";
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
import { decodeCard, encodeCard } from "./card";
import { Inbox } from "./inbox";
import { defaultKeyClients, ensureKey, type KeyDeps, loadKey } from "./keys";
import {
	fetchNew,
	type Gate,
	type Invite,
	type Message,
	type PhoneFriendPool,
	publish,
	ring,
	subscribe,
	wrap,
} from "./chat";
import {
	clearInvite,
	type PhoneFriendConfig,
	readConfig,
	readInvite,
	writeConfig,
	writeInvite,
} from "./store";

export type PhoneFriendDeps = KeyDeps & {
	createPool: () => PhoneFriendPool & { close(relays: string[]): void };
	spawnListener: (paths: DgPaths) => number;
	isAlive: (pid: number) => boolean;
	kill: (pid: number) => void;
	write: (text: string) => void;
	sleep: (ms: number) => Promise<void>;
	readStdin: () => Promise<string | undefined>;
	now: () => number;
};

const FOLLOW_POLL_MS = 1000;
const STOP_WAIT_MS = 5000;
const MAX_SEND_BYTES = 64 * 1024;
const DEFAULT_INVITE_HOURS = 24;
const SECRET_BYTES = 32;

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

function defaultDeps(session?: string): PhoneFriendDeps {
	const paths = resolveDgPaths();
	return {
		paths,
		...defaultKeyClients(paths, session),
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
		now: () => Math.floor(Date.now() / 1000),
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
		throw new DgCliError(
			"no contact saved; run `dg-agent phone-friend dial <card>` with a call card from the other side",
		);
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

function npubOf(sk: Uint8Array): string {
	return nip19.npubEncode(getPublicKey(sk));
}

async function myNpub(deps: PhoneFriendDeps): Promise<string> {
	return npubOf((await ensureKey(deps)).sk);
}

async function mySecretKey(deps: PhoneFriendDeps): Promise<Uint8Array> {
	return (await ensureKey(deps)).sk;
}

export async function phoneNumber(deps: PhoneFriendDeps): Promise<void> {
	const { sk, mode } = await ensureKey(deps);
	printJson(deps, {
		npub: npubOf(sk),
		contact: readConfig(deps.paths).contact ?? null,
		key_store: mode,
		listener: livePid(deps) ?? null,
	});
}

function liveInvite(deps: PhoneFriendDeps): Invite | undefined {
	const invite = readInvite(deps.paths);
	return invite && invite.expiresAt > deps.now() ? invite : undefined;
}

function gateFor(config: PhoneFriendConfig, deps: PhoneFriendDeps): Gate {
	return {
		contact: config.contact ? contactHex(config.contact) : undefined,
		invite: liveInvite(deps),
	};
}

function acceptCall(message: Message, deps: PhoneFriendDeps): void {
	if (!message.call) return;
	clearInvite(deps.paths);
	writeConfig(deps.paths, { ...readConfig(deps.paths), contact: message.from });
}

async function spawnOrRestart(deps: PhoneFriendDeps): Promise<{ pid: number; status: string }> {
	const running = livePid(deps);
	if (running !== undefined) await stopListener(running, deps);
	const pid = deps.spawnListener(deps.paths);
	writeFileAtomic(deps.paths.phoneFriendPidPath, `${pid}\n`, 0o600);
	return { pid, status: running === undefined ? "started" : "restarted" };
}

export async function phoneOn(deps: PhoneFriendDeps): Promise<void> {
	const config = readConfig(deps.paths);
	const npub = await myNpub(deps);
	const contact = config.contact ?? null;
	if (!contact && !liveInvite(deps)) {
		throw new DgCliError(
			"no contact yet; run `dg-agent phone-friend invite` and give the card to the other side, " +
				"or `dg-agent phone-friend dial <card>`",
		);
	}
	const running = livePid(deps);
	if (running !== undefined) {
		printJson(deps, { npub, contact, pid: running, status: "running" });
		return;
	}
	printJson(deps, { npub, contact, ...(await spawnOrRestart(deps)) });
}

export async function phoneInvite(
	opts: { relay?: string[]; ttl?: string },
	deps: PhoneFriendDeps,
): Promise<void> {
	const hours = opts.ttl === undefined ? DEFAULT_INVITE_HOURS : Number(opts.ttl);
	if (!Number.isFinite(hours) || hours <= 0) {
		throw new DgCliError(`ttl must be a positive number of hours, got "${opts.ttl}"`);
	}
	const config = readConfig(deps.paths);
	if (opts.relay?.length) config.relays = opts.relay;
	const invite = {
		secret: randomBytes(SECRET_BYTES).toString("hex"),
		expiresAt: deps.now() + Math.round(hours * 3600),
	};
	const card = encodeCard({
		npub: await myNpub(deps),
		relays: config.relays,
		secret: invite.secret,
		exp: invite.expiresAt,
	});
	writeConfig(deps.paths, config);
	writeInvite(deps.paths, invite);
	if (livePid(deps) !== undefined) await spawnOrRestart(deps);
	printJson(deps, { card, expires_at: new Date(invite.expiresAt * 1000).toISOString() });
}

export async function phoneDial(
	text: string,
	firstWords: string | undefined,
	deps: PhoneFriendDeps,
): Promise<void> {
	const pasted = text === "-" ? await deps.readStdin() : text;
	if (!pasted) throw new DgCliError("no call card given");
	const card = decodeCard(pasted, deps.now());
	const sk = await mySecretKey(deps);
	const words = firstWords || "hello";
	const event = ring(words, sk, contactHex(card.npub), card.secret);
	const pool = deps.createPool();
	try {
		const { ok } = await publish(pool, card.relays, event);
		if (ok.length === 0) throw new DgCliError("no relay accepted the call");
		writeConfig(deps.paths, { ...readConfig(deps.paths), contact: card.npub, relays: card.relays });
		saveSent(deps, { id: event.id, ts: deps.now(), from: npubOf(sk), text: words, call: true }, card.npub);
		if (livePid(deps) !== undefined) await spawnOrRestart(deps);
		printJson(deps, { contact: card.npub, id: event.id, relays_ok: ok });
	} finally {
		pool.close(card.relays);
	}
}

export async function phoneOff(deps: PhoneFriendDeps): Promise<void> {
	const pid = livePid(deps);
	if (pid !== undefined) await stopListener(pid, deps);
	rmSync(deps.paths.phoneFriendPidPath, { force: true });
	printJson(deps, { pid: pid ?? null, status: "off" });
}

function printUnread(inbox: Inbox, deps: PhoneFriendDeps): void {
	for (const message of inbox.takeUnread()) printJson(deps, message);
}

function openInbox(deps: PhoneFriendDeps): Inbox {
	return Inbox.open(deps.paths, deps.now);
}

export async function phoneAnswer(deps: PhoneFriendDeps): Promise<void> {
	if (livePid(deps) === undefined) {
		throw new DgCliError("the phone-friend listener is off; run `dg-agent phone-friend on`");
	}
	const inbox = openInbox(deps);
	try {
		for (;;) {
			printUnread(inbox, deps);
			await deps.sleep(FOLLOW_POLL_MS);
			if (livePid(deps) === undefined) {
				printUnread(inbox, deps);
				throw new DgCliError("the phone-friend listener stopped");
			}
		}
	} finally {
		inbox.close();
	}
}

export async function phoneVoicemail(deps: PhoneFriendDeps): Promise<void> {
	const inbox = openInbox(deps);
	try {
		if (livePid(deps) === undefined) {
			const config = readConfig(deps.paths);
			const gate = gateFor(config, deps);
			if (!gate.contact && !gate.invite) requireContact(config);
			const pool = deps.createPool();
			try {
				const { messages, seen } = await fetchNew(
					pool,
					config.relays,
					await mySecretKey(deps),
					gate,
					inbox.seen(),
					deps.now,
				);
				for (const message of messages) {
					inbox.add(message, "in", message.from);
					acceptCall(message, deps);
				}
				inbox.setCursor(seen.cursor);
			} finally {
				pool.close(config.relays);
			}
		}
		printUnread(inbox, deps);
	} finally {
		inbox.close();
	}
}

function saveSent(deps: PhoneFriendDeps, sent: Message, contact: string): void {
	const inbox = openInbox(deps);
	try {
		inbox.add(sent, "out", contact);
	} finally {
		inbox.close();
	}
}

export async function phoneSay(text: string, deps: PhoneFriendDeps): Promise<void> {
	const config = readConfig(deps.paths);
	const contact = contactHex(requireContact(config));
	const body = text === "-" ? (await deps.readStdin())?.replace(/\n$/, "") : text;
	if (!body) throw new DgCliError("message text is empty");
	const sk = await mySecretKey(deps);
	const event = wrap(body, sk, contact);
	const pool = deps.createPool();
	try {
		const { ok } = await publish(pool, config.relays, event);
		if (ok.length === 0) throw new DgCliError("no relay accepted the message");
		saveSent(deps, { id: event.id, ts: deps.now(), from: npubOf(sk), text: body }, config.contact as string);
		printJson(deps, { id: event.id, relays_ok: ok });
	} finally {
		pool.close(config.relays);
	}
}

async function phoneRun(deps: PhoneFriendDeps): Promise<void> {
	const config = readConfig(deps.paths);
	const gate = gateFor(config, deps);
	if (!gate.contact && !gate.invite) requireContact(config);
	const key = await loadKey(deps);
	if (!key) throw new DgCliError("no phone-friend key yet; run `dg-agent phone-friend number`");
	const inbox = openInbox(deps);
	const pool = deps.createPool();
	const sub = subscribe(
		pool,
		config.relays,
		key.sk,
		gate,
		inbox.seen(),
		(message, seen) => {
			inbox.add(message, "in", message.from);
			inbox.setCursor(seen.cursor);
			acceptCall(message, deps);
		},
		deps.now,
	);
	const shutdown = () => {
		sub.close();
		pool.close(config.relays);
		inbox.close();
		if (readPid(deps.paths) === process.pid) rmSync(deps.paths.phoneFriendPidPath, { force: true });
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	await new Promise(() => {});
}

export function registerPhoneFriendCommands(
	program: Command,
	makeDeps: (session?: string) => PhoneFriendDeps = defaultDeps,
): void {
	let session: string | undefined;
	const phone = program
		.command("phone-friend")
		.description("private NIP-17 chat with one contact over public Nostr relays")
		.hook("preAction", (_hooked, action) => {
			session = action.optsWithGlobals<{ session?: string }>().session;
		});

	phone
		.command("number")
		.description("print your number (npub), your contact, and the listener state")
		.action(() => phoneNumber(makeDeps(session)));

	phone
		.command("invite")
		.description("make a one-time call card; give it to the other side so it can dial you")
		.option("--relay <url...>", "relays to use instead of the saved ones")
		.option("--ttl <hours>", "hours until the card expires", String(DEFAULT_INVITE_HOURS))
		.action((opts: { relay?: string[]; ttl?: string }) => phoneInvite(opts, makeDeps(session)));

	phone
		.command("dial")
		.description("call the owner of a call card: save them as your contact and ring them")
		.argument("<card>", "the call card from `phone-friend invite`, or - to read it from stdin")
		.argument("[text]", "first words to send", "hello")
		.action((card: string, text: string) => phoneDial(card, text, makeDeps(session)));

	phone
		.command("on")
		.description("start the background listener")
		.action(() => phoneOn(makeDeps(session)));

	phone
		.command("off")
		.description("stop the background listener")
		.action(() => phoneOff(makeDeps(session)));

	phone
		.command("answer")
		.description("stay on the line: print new messages as JSON lines until the listener stops")
		.action(() => phoneAnswer(makeDeps(session)));

	phone
		.command("voicemail")
		.description("print unread messages as JSON lines, then exit")
		.action(() => phoneVoicemail(makeDeps(session)));

	phone
		.command("say")
		.description("send one message to your contact")
		.argument("<text>", "message text, or - to read it from stdin")
		.action((text: string) => phoneSay(text, makeDeps(session)));

	phone
		.command("__run", { hidden: true })
		.action(() => phoneRun(makeDeps(session)));
}
