import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
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
import { decodeCard, encodeCard, isCardRelays, MAX_CARD_RELAYS } from "./card";
import { PhoneFriendDb } from "./db";
import { DEFAULT_LINE, isLineName, type LinePaths } from "./line";
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
	acceptCall as saveCaller,
	claimStart,
	lineClaiming,
	listLines,
	releaseStart,
	type PhoneFriendConfig,
	readConfig,
	readInvite,
	resolveLine,
	writeConfig,
	writeInvite,
} from "./store";

export type PhoneFriendDeps = KeyDeps & {
	createPool: () => PhoneFriendPool & { close(relays: string[]): void };
	spawnListener: (line: LinePaths) => number;
	isAlive: (pid: number) => boolean;
	kill: (pid: number) => void;
	write: (text: string) => void;
	sleep: (ms: number) => Promise<void>;
	readStdin: () => Promise<string | undefined>;
	now: () => number;
};

const FOLLOW_POLL_MS = 1000;
const STOP_WAIT_MS = 5000;
const MAX_RESTART_ATTEMPTS = 3;
const STABLE_TICKS_TO_RESET = 3;
const MAX_SEND_BYTES = 64 * 1024;
const DEFAULT_INVITE_HOURS = 24;
const SECRET_BYTES = 32;

export function isListenerArgs(args: string[]): boolean {
	return args.includes("phone-friend") && args.includes("__run");
}

function isOurListener(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	const cmdline = `/proc/${pid}/cmdline`;
	if (existsSync(cmdline)) {
		return isListenerArgs(readFileSync(cmdline, "utf8").split("\0"));
	}
	if (process.platform === "win32") {
		const query = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
		const ps = spawnSync("powershell", ["-NoProfile", "-Command", query], { encoding: "utf8" });
		return ps.status === 0 && isListenerArgs(ps.stdout.trim().split(/\s+/));
	}
	const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
	return ps.status === 0 && isListenerArgs(ps.stdout.trim().split(/\s+/));
}

function defaultDeps(session?: string, line: string = DEFAULT_LINE): PhoneFriendDeps {
	const paths = resolveDgPaths();
	return {
		paths,
		line: resolveLine(paths, line),
		...defaultKeyClients(paths, session),
		createPool: () => new SimplePool({ enableReconnect: true }),
		spawnListener: (listenerLine) => {
			ensurePrivateDir(listenerLine.dir);
			const log = openSync(listenerLine.logPath, "a", 0o600);
			chmodSync(listenerLine.logPath, 0o600);
			const [command, ...args] = selfCommand(["phone-friend", "--line", listenerLine.name, "__run"]);
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

function readPid(line: LinePaths): number | undefined {
	if (!existsSync(line.pidPath)) return undefined;
	const pid = Number(readFileSync(line.pidPath, "utf8").trim());
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function livePid(deps: PhoneFriendDeps): number | undefined {
	const pid = readPid(deps.line);
	return pid !== undefined && deps.isAlive(pid) ? pid : undefined;
}

async function stopListener(pid: number, deps: PhoneFriendDeps): Promise<void> {
	deps.kill(pid);
	for (let waited = 0; deps.isAlive(pid) && waited < STOP_WAIT_MS; waited += 100) {
		await deps.sleep(100);
	}
	if (deps.isAlive(pid)) throw new DgCliError(`the phone-friend listener (pid ${pid}) did not stop`);
	rmSync(deps.line.pidPath, { force: true });
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

function expiresAt(invite: Invite): string {
	return new Date(invite.expiresAt * 1000).toISOString();
}

export async function phoneNumber(deps: PhoneFriendDeps): Promise<void> {
	const { sk, mode } = await ensureKey(deps);
	const invite = liveInvite(deps);
	printJson(deps, {
		line: deps.line.name,
		npub: npubOf(sk),
		contact: readConfig(deps.line).contact ?? null,
		name: readConfig(deps.line).name ?? null,
		key_store: mode,
		listener: livePid(deps) ?? null,
		...(invite ? { card_expires_at: expiresAt(invite) } : {}),
	});
}

function requireFreeName(name: string, deps: PhoneFriendDeps): void {
	if (!isLineName(name)) {
		throw new DgCliError(`a contact name must be 1-32 lowercase letters, digits, or dashes, got "${name}"`);
	}
	const taken = lineClaiming(deps.paths, deps.line, name);
	if (taken) throw new DgCliError(`"${name}" is already used by line ${taken.name}`);
}

export function phoneName(name: string, deps: PhoneFriendDeps): void {
	const config = readConfig(deps.line);
	const contact = requireContact(config);
	requireFreeName(name, deps);
	writeConfig(deps.line, { ...config, name });
	printJson(deps, { line: deps.line.name, name, contact });
}

export function phoneContacts(deps: PhoneFriendDeps): void {
	for (const line of listLines(deps.paths)) {
		const config = readConfig(line);
		const pid = readPid(line);
		printJson(deps, {
			line: line.name,
			name: config.name ?? null,
			contact: config.contact ?? null,
			listener: pid !== undefined && deps.isAlive(pid) ? pid : null,
		});
	}
}

export async function phoneCard(deps: PhoneFriendDeps): Promise<void> {
	const invite = liveInvite(deps);
	if (!invite) {
		throw new DgCliError("no open call card on this line; run `dg-agent phone-friend invite` to make one");
	}
	const card = encodeCard({
		npub: await myNpub(deps),
		relays: readConfig(deps.line).relays,
		secret: invite.secret,
		exp: invite.expiresAt,
	});
	printJson(deps, { card, expires_at: expiresAt(invite) });
}

function liveInvite(deps: PhoneFriendDeps): Invite | undefined {
	const invite = readInvite(deps.line);
	return invite && invite.expiresAt > deps.now() ? invite : undefined;
}

function canConnect(config: PhoneFriendConfig, deps: PhoneFriendDeps): boolean {
	return Boolean(config.contact) || liveInvite(deps) !== undefined;
}

function gateFor(config: PhoneFriendConfig, deps: PhoneFriendDeps): Gate {
	return {
		contact: config.contact ? contactHex(config.contact) : undefined,
		invite: liveInvite(deps),
	};
}

function acceptCall(message: Message, deps: PhoneFriendDeps): void {
	if (message.call) saveCaller(deps.paths, deps.line, message.from);
}

async function spawnOrRestart(deps: PhoneFriendDeps): Promise<{ pid: number; status: string }> {
	let token = claimStart(deps.line, deps.now());
	for (let waited = 0; token === undefined; waited += 100) {
		if (waited >= STOP_WAIT_MS) {
			throw new DgCliError("another phone-friend command is starting the listener on this line; try again");
		}
		await deps.sleep(100);
		token = claimStart(deps.line, deps.now());
	}
	try {
		const running = livePid(deps);
		if (running !== undefined) await stopListener(running, deps);
		const pid = deps.spawnListener(deps.line);
		try {
			writeFileAtomic(deps.line.pidPath, `${pid}\n`, 0o600);
		} catch (err) {
			deps.kill(pid);
			throw err;
		}
		return { pid, status: running === undefined ? "started" : "restarted" };
	} finally {
		releaseStart(deps.line, token);
	}
}

export async function phoneOn(deps: PhoneFriendDeps): Promise<void> {
	const config = readConfig(deps.line);
	const npub = await myNpub(deps);
	const contact = config.contact ?? null;
	if (!canConnect(config, deps)) {
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
	opts: { relay?: string[]; ttl?: string; name?: string },
	deps: PhoneFriendDeps,
): Promise<void> {
	if (opts.name !== undefined) requireFreeName(opts.name, deps);
	const hours = opts.ttl === undefined ? DEFAULT_INVITE_HOURS : Number(opts.ttl);
	if (!Number.isFinite(hours) || hours <= 0) {
		throw new DgCliError(`ttl must be a positive number of hours, got "${opts.ttl}"`);
	}
	const relays = opts.relay?.length ? opts.relay : readConfig(deps.line).relays;
	if (!isCardRelays(relays)) {
		throw new DgCliError(`--relay must be 1 to ${MAX_CARD_RELAYS} wss:// URLs`);
	}
	const invite = {
		secret: randomBytes(SECRET_BYTES).toString("hex"),
		expiresAt: deps.now() + Math.round(hours * 3600),
		...(opts.name === undefined ? {} : { name: opts.name }),
	};
	const card = encodeCard({
		npub: await myNpub(deps),
		relays,
		secret: invite.secret,
		exp: invite.expiresAt,
	});
	writeInvite(deps.line, invite, relays);
	if (livePid(deps) !== undefined) await spawnOrRestart(deps);
	printJson(deps, { card, expires_at: expiresAt(invite) });
}

export async function phoneDial(
	text: string,
	firstWords: string | undefined,
	deps: PhoneFriendDeps,
	name?: string,
): Promise<void> {
	if (name !== undefined) requireFreeName(name, deps);
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
		writeConfig(deps.line, {
			...readConfig(deps.line),
			contact: card.npub,
			relays: card.relays,
			...(name === undefined ? {} : { name }),
		});
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
	rmSync(deps.line.pidPath, { force: true });
	printJson(deps, { pid: pid ?? null, status: "off" });
}

function printUnread(inbox: PhoneFriendDb, deps: PhoneFriendDeps): void {
	for (const message of inbox.takeUnread()) printJson(deps, message);
}

function openInbox(deps: PhoneFriendDeps): PhoneFriendDb {
	return PhoneFriendDb.open(deps.line, deps.now);
}

export async function phoneAnswer(
	deps: PhoneFriendDeps,
	opts: { restart?: boolean } = {},
): Promise<void> {
	let restartAttempts = 0;
	let stableTicks = 0;
	async function respawn(): Promise<void> {
		printJson(deps, await spawnOrRestart(deps));
	}
	if (livePid(deps) === undefined) {
		if (!opts.restart || !canConnect(readConfig(deps.line), deps)) {
			throw new DgCliError("the phone-friend listener is off; run `dg-agent phone-friend on`");
		}
		await respawn();
		restartAttempts = 1;
	}
	const inbox = openInbox(deps);
	try {
		for (;;) {
			printUnread(inbox, deps);
			await deps.sleep(FOLLOW_POLL_MS);
			if (livePid(deps) === undefined) {
				printUnread(inbox, deps);
				if (!opts.restart) throw new DgCliError("the phone-friend listener stopped");
				if (!canConnect(readConfig(deps.line), deps)) {
					throw new DgCliError(
						"the phone-friend listener stopped and there is no contact or live invite to restart it with",
					);
				}
				if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
					throw new DgCliError(
						`the phone-friend listener keeps dying right after it restarts (tried ${MAX_RESTART_ATTEMPTS} times); check ${deps.line.logPath}`,
					);
				}
				stableTicks = 0;
				await respawn();
				restartAttempts += 1;
			} else if (restartAttempts > 0) {
				stableTicks += 1;
				if (stableTicks >= STABLE_TICKS_TO_RESET) restartAttempts = 0;
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
			const config = readConfig(deps.line);
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
	const config = readConfig(deps.line);
	const contactNpub = requireContact(config);
	const contact = contactHex(contactNpub);
	const body = text === "-" ? (await deps.readStdin())?.replace(/\n$/, "") : text;
	if (!body) throw new DgCliError("message text is empty");
	const sk = await mySecretKey(deps);
	const event = wrap(body, sk, contact);
	const pool = deps.createPool();
	try {
		const { ok } = await publish(pool, config.relays, event);
		if (ok.length === 0) throw new DgCliError("no relay accepted the message");
		saveSent(deps, { id: event.id, ts: deps.now(), from: npubOf(sk), text: body }, contactNpub);
		printJson(deps, { id: event.id, relays_ok: ok });
	} finally {
		pool.close(config.relays);
	}
}

async function phoneRun(deps: PhoneFriendDeps): Promise<void> {
	const config = readConfig(deps.line);
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
		if (readPid(deps.line) === process.pid) rmSync(deps.line.pidPath, { force: true });
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	await new Promise(() => {});
}

export function registerPhoneFriendCommands(
	program: Command,
	makeDeps: (session?: string, line?: string) => PhoneFriendDeps = defaultDeps,
): void {
	let session: string | undefined;
	let line: string | undefined;
	const phone = program
		.command("phone-friend")
		.description("private NIP-17 chat with one contact over public Nostr relays")
		.option(
			"--line <name>",
			"which of your numbers to use: a line name, a contact name, or a contact npub; each line has its own key and contact",
			DEFAULT_LINE,
		)
		.hook("preAction", (_hooked, action) => {
			({ session, line } = action.optsWithGlobals<{ session?: string; line?: string }>());
		});

	phone
		.command("number")
		.description("print your number (npub), your contact, and the listener state")
		.action(() => phoneNumber(makeDeps(session, line)));

	phone
		.command("name")
		.description("save a name for this line's contact, so --line <name> reaches it")
		.argument("<name>", "1-32 lowercase letters, digits, or dashes")
		.action((name: string) => phoneName(name, makeDeps(session, line)));

	phone
		.command("contacts")
		.description("list every line with its contact name, npub, and listener")
		.action(() => phoneContacts(makeDeps(session, line)));

	phone
		.command("card")
		.description("print the open call card again, so the other side can dial in before it expires")
		.action(() => phoneCard(makeDeps(session, line)));

	phone
		.command("invite")
		.description("make a one-time call card; give it to the other side so it can dial you")
		.option("--relay <url...>", "relays to use instead of the saved ones")
		.option("--ttl <hours>", "hours until the card expires", String(DEFAULT_INVITE_HOURS))
		.option("--name <name>", "name to give the contact once the call is answered")
		.action((opts: { relay?: string[]; ttl?: string; name?: string }) => phoneInvite(opts, makeDeps(session, line)));

	phone
		.command("dial")
		.description("call the owner of a call card: save them as your contact and ring them")
		.argument("<card>", "the call card from `phone-friend invite`, or - to read it from stdin")
		.argument("[text]", "first words to send", "hello")
		.option("--name <name>", "name to give the card's owner as your contact")
		.action((card: string, text: string, opts: { name?: string }) =>
			phoneDial(card, text, makeDeps(session, line), opts.name),
		);

	phone
		.command("on")
		.description("start the background listener")
		.action(() => phoneOn(makeDeps(session, line)));

	phone
		.command("off")
		.description("stop the background listener")
		.action(() => phoneOff(makeDeps(session, line)));

	phone
		.command("answer")
		.description(
			"stay on the line: print new messages as JSON lines until the listener stops, or restart it instead with --restart",
		)
		.option(
			"--restart",
			"if the listener stops, restart it and keep answering (for an unattended Monitor watch)",
		)
		.action((opts: { restart?: boolean }) => phoneAnswer(makeDeps(session, line), opts));

	phone
		.command("voicemail")
		.description("print unread messages as JSON lines, then exit")
		.action(() => phoneVoicemail(makeDeps(session, line)));

	phone
		.command("say")
		.description("send one message to your contact")
		.argument("<text>", "message text, or - to read it from stdin")
		.action((text: string) => phoneSay(text, makeDeps(session, line)));

	phone
		.command("__run", { hidden: true })
		.action(() => phoneRun(makeDeps(session, line)));
}
