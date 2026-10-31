import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { DgCliError } from "@dg/common";
import { ensurePrivateDir, readCappedStdin, resolveDgPaths, selfCommand, writeFileAtomic, writeStdout } from "@dg/common/node";
import type { Command } from "commander";
import { type AcceptOpts, resolveAcceptHandle, signingKeyForAccept } from "./accept-name";
import { type AutostartDeps, formatAutostartState, installAutostart, managedRestartCommands, removeAutostart } from "./autostart";
import { decodeCard, encodeCard, isCardRelays, MAX_CARD_RELAYS, NO_EXPIRY, SECRET_BYTES } from "./card";
import { npubOf, type PhonePool, type PublishReport, publish, ring, shouldSaveOutgoing, wrap } from "./chat";
import {
	INBOX_RELAY_CACHE_SECONDS,
	createPhonePool,
	lookupInboxRelays,
	publishRelaySet,
	resolvePublishConfirmMs,
	PUBLISH_CONFIRM_ENV,
} from "./delivery";
import { PHONE_SYSTEM_SENDER, PhoneDb } from "./db";
import { defaultKeyClients, ensureKey, type KeyDeps, ensureNumberKey } from "./keys";
import {
	defaultOnSignal,
	defaultSchedule,
	isOurListener,
	listenerDrift,
	listenerLogPath,
	readListenerPid,
	removeListenerPid,
	runListener,
	spawnDetachedListener,
	type ListenerPid,
} from "./listener";
import { legacyRoot, legacyRootPresent, migrateIfNeeded, readOnlyLegacyView, runArgv } from "./migrate";
import { DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS, parseOnMessageTimeoutSeconds, PHONE_SAFETY_REF, type CommandPushTarget } from "./push";
import {
	addContact,
	insertNewContact,
	addInvite,
	addPhoneNotice,
	findContactByHandle,
	findContactByNpub,
	FALLBACK_SELF_NAME,
	isHandle,
	liveInvites,
	normalizeHandle,
	numberKeyId,
	type OnMessageConfig,
	pubkeyHex,
	readListener,
	readNumber,
	readRelays,
	readInboxRelayCache,
	readPublishConfirmSetting,
	removeContact,
	renameContact,
	clearListener,
	requireFreeHandle,
	resolvedSelfName,
	writeInboxRelayCache,
	writeListener,
	writeNumber,
	writeRelays,
	latestPhoneNotice,
	listContacts,
	notePhoneDrift,
} from "./store";

export type PhoneDeps = KeyDeps & {
	createPool: () => PhonePool & { close(relays: string[]): void };
	write: (text: string) => void;
	writeErr?: (text: string) => void;
	readStdin: () => Promise<string | undefined>;
	now: () => number;
	/** Present on the real CLI so a writing command can restart a listener whose version or keys drifted. */
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	spawnListener?: (argv: string[], logPath: string) => number;
	isOurListener?: (pid: number) => boolean;
	run?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
	uid?: number;
	sleep?: (ms: number) => Promise<void>;
	listenerArgv?: (extraArgs: string[]) => string[];
};

export type RunDeps = PhoneDeps & {
	pid: number;
	schedule: Parameters<typeof runListener>[0]["schedule"];
	onSignal: Parameters<typeof runListener>[0]["onSignal"];
};

export type OpenCloseDeps = PhoneDeps &
	AutostartDeps & {
		which: (name: string) => string | undefined;
		/** The full argv a unit file or a detached spawn should run; production resolves this
		 * binary's own invocation with `selfCommand`, tests fake it with a deterministic path. */
		listenerArgv: (extraArgs: string[]) => string[];
		spawnListener: (argv: string[], logPath: string) => number;
		kill: (pid: number, signal: NodeJS.Signals) => void;
		isOurListener: (pid: number) => boolean;
		sleep: (ms: number) => Promise<void>;
	};

const MAX_SEND_BYTES = 64 * 1024;
const DEFAULT_INVITE_HOURS = 24;
const STOP_WAIT_MS = 5000;

function isManagedKind(kind: string | undefined): kind is "systemd" | "launchd" | "task" {
	return kind === "systemd" || kind === "launchd" || kind === "task";
}

/** Stops a listener this binary started when its version or keys no longer match the database.
 * Does nothing unless `kill` and `isOurListener` are injected, and never signals this process.
 * A managed restart runs only from a separate command. `phone __run` signals the other pid and
 * then subscribes itself, so it cannot restart the unit it is running under. */
async function restartStaleListener(deps: PhoneDeps, opts: { spawn: boolean }): Promise<void> {
	if (!deps.kill || !deps.isOurListener) return;
	const running = readListenerPid(deps.paths);
	if (!running || running.pid === process.pid || !deps.isOurListener(running.pid)) return;
	const drift = await listenerDrift(deps, running);
	if (!drift.restart) return;
	if (drift.token && drift.notice) notePhoneDrift(deps.db, drift.token, drift.notice, deps.now());
	const saved = readListener(deps.db);
	const kind = saved?.autostart?.kind;
	if (isManagedKind(kind) && deps.run && opts.spawn) {
		for (const argv of managedRestartCommands(kind, deps.uid ?? 0)) await deps.run(argv);
		return;
	}
	deps.kill(running.pid, "SIGTERM");
	if (deps.sleep) {
		for (let waited = 0; readListenerPid(deps.paths)?.pid === running.pid && waited < STOP_WAIT_MS; waited += 100) {
			await deps.sleep(100);
		}
	}
	if (readListenerPid(deps.paths)?.pid === running.pid) {
		const message = `the phone listener (pid ${running.pid}) did not stop; left it running`;
		if (!opts.spawn) throw new DgCliError(message);
		const line = `phone: ${message}\n`;
		if (deps.writeErr) deps.writeErr(line);
		else process.stderr.write(line);
		return;
	}
	if (!opts.spawn || !deps.spawnListener || !deps.listenerArgv) return;
	deps.spawnListener(deps.listenerArgv(onMessageArgvFor(saved?.onMessage)), listenerLogPath(deps.paths));
}

/** The CLI entry point. `db` migrates on first use, and only then, so a read-only command can
 * look at `paths` without creating `phone.db`. Migration must still run before `PhoneDb.open`
 * creates that file, since `legacyRoot` stops seeing a legacy install the moment it exists. */
function defaultDeps(session?: string): PhoneDeps {
	const paths = resolveDgPaths();
	let db: PhoneDb | undefined;
	return {
		paths,
		get db() {
			if (!db) {
				migrateIfNeeded(paths);
				db = PhoneDb.open(paths);
			}
			return db;
		},
		...defaultKeyClients(paths, session),
		createPool: () => createPhonePool(),
		write: writeStdout,
		writeErr: (text) => {
			process.stderr.write(text);
		},
		readStdin: () => readCappedStdin(MAX_SEND_BYTES),
		now: () => Math.floor(Date.now() / 1000),
		kill: (pid, signal) => process.kill(pid, signal),
		spawnListener: defaultSpawnListener,
		isOurListener,
		run: runArgv,
		uid: process.getuid?.() ?? 0,
		sleep: (ms) => Bun.sleep(ms),
		listenerArgv: (extraArgs) => selfCommand(["phone", "__run", ...extraArgs]),
	};
}

/** Detached, `unref`'d, logging to `<phoneRoot>/listener.log`: the same shape phone-friend's `on` used. */
function defaultSpawnListener(argv: string[], logPath: string): number {
	return spawnDetachedListener(argv, logPath);
}

function defaultOpenCloseDeps(session?: string): OpenCloseDeps {
	return {
		...defaultDeps(session),
		platform: process.platform,
		homeDir: homedir(),
		env: process.env,
		uid: process.getuid?.() ?? 0,
		writeFile: (path, data, mode) => {
			ensurePrivateDir(dirname(path));
			writeFileAtomic(path, typeof data === "string" ? data : Buffer.from(data), mode);
		},
		removeFile: (path) => rmSync(path, { force: true }),
		fileExists: existsSync,
		run: runArgv,
		which: (name) => Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? undefined,
		listenerArgv: (extraArgs) => selfCommand(["phone", "__run", ...extraArgs]),
		spawnListener: defaultSpawnListener,
		kill: (pid, signal) => process.kill(pid, signal),
		isOurListener,
		sleep: (ms) => Bun.sleep(ms),
	};
}

function printJson(deps: PhoneDeps, value: unknown): void {
	deps.write(`${JSON.stringify(value)}\n`);
}

function confirmMsFor(deps: PhoneDeps): number {
	return resolvePublishConfirmMs(process.env[PUBLISH_CONFIRM_ENV], readPublishConfirmSetting(deps.db));
}

function relayFields(report: PublishReport): { relays_ok: string[]; relays_unconfirmed: string[]; relays_failed: { relay: string; reason: string }[] } {
	return { relays_ok: report.ok, relays_unconfirmed: report.unconfirmed, relays_failed: report.failed };
}

function rejectedSend(kind: "call" | "message", report: PublishReport): string {
	const lead = kind === "call" ? "no relay accepted the call" : "no relay accepted the message";
	if (report.failed.length === 0) return lead;
	return `${lead}: ${report.failed.map((failure) => `${failure.relay}: ${failure.reason}`).join("; ")}`;
}

/** Card relays, the recipient's kind 10050 relays, and our relays. A lookup miss still returns the other two. */
async function outgoingRelays(
	deps: PhoneDeps,
	pool: PhonePool,
	cardRelays: string[],
	npub: string,
): Promise<{ relays: string[]; queried: string[] }> {
	const own = readRelays(deps.db);
	const pubkey = pubkeyHex(npub);
	const queried = publishRelaySet({ inbox: [], card: cardRelays, own });
	const inbox = await lookupInboxRelays(pool, queried, pubkey, {
		read: () => readInboxRelayCache(deps.db, pubkey, deps.now(), INBOX_RELAY_CACHE_SECONDS),
		write: (relays) => writeInboxRelayCache(deps.db, pubkey, relays, deps.now()),
	});
	return { relays: publishRelaySet({ inbox, card: cardRelays, own }), queried };
}

function closeRelayPool(pool: PhonePool & { close(relays: string[]): void }, relays: string[]): void {
	pool.close([...new Set(relays)]);
}

const MIGRATION_HINT = `${JSON.stringify({ migration_pending: true, next: "run phone open to migrate" })}\n`;

function warnMigrationPending(deps: PhoneDeps): void {
	if (deps.writeErr) deps.writeErr(MIGRATION_HINT);
	else process.stderr.write(MIGRATION_HINT);
}

function isoOf(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toISOString();
}

export async function phoneNumber(
	opts: { as?: string; rotate?: boolean; relay?: string[] },
	deps: PhoneDeps,
): Promise<void> {
	migrateIfNeeded(deps.paths);
	if (opts.as !== undefined && !isHandle(opts.as)) {
		throw new DgCliError(`--as must be 1-32 lowercase letters, digits, or dashes, got "${opts.as}"`);
	}
	const { sk, mode } = await ensureNumberKey(deps);
	if (opts.relay?.length) {
		if (!isCardRelays(opts.relay)) throw new DgCliError(`--relay must be 1 to ${MAX_CARD_RELAYS} wss:// URLs`);
		writeRelays(deps.db, opts.relay);
	}
	const relays = readRelays(deps.db);
	const existing = readNumber(deps.db);
	const as = opts.as ?? existing?.as ?? FALLBACK_SELF_NAME;
	const rotated = Boolean(opts.rotate);
	const secret = rotated || !existing ? randomBytes(SECRET_BYTES).toString("hex") : existing.secret;
	const rotatedAt = rotated ? deps.now() : existing?.rotatedAt;
	writeNumber(deps.db, { secret, as, ...(rotatedAt === undefined ? {} : { rotatedAt }) });
	await restartStaleListener(deps, { spawn: true });
	const card = encodeCard({ npub: npubOf(sk), relays, secret, exp: NO_EXPIRY, handle: as });
	const listener = readListenerPid(deps.paths);
	printJson(deps, {
		card,
		npub: npubOf(sk),
		as,
		relays,
		expires_at: null,
		open_invites: liveInvites(deps.db).map((invite) => ({
			handle: invite.name === undefined ? null : `+${invite.name}`,
			expires_at: isoOf(invite.expiresAt),
		})),
		rotated,
		key_store: mode,
		listener: listener ? { pid: listener.pid, since: listener.since } : null,
		safety: PHONE_SAFETY_REF,
	});
}

export async function phoneInvite(
	opts: { relay?: string[]; ttl?: string; as?: string; name?: string },
	deps: PhoneDeps,
): Promise<void> {
	migrateIfNeeded(deps.paths);
	const hours = opts.ttl === undefined ? DEFAULT_INVITE_HOURS : Number(opts.ttl);
	if (!Number.isFinite(hours) || hours <= 0) {
		throw new DgCliError(`ttl must be a positive number of hours, got "${opts.ttl}"`);
	}
	if (opts.as !== undefined && !isHandle(opts.as)) {
		throw new DgCliError(`--as must be 1-32 lowercase letters, digits, or dashes, got "${opts.as}"`);
	}
	if (opts.name !== undefined) requireFreeHandle(deps.db, opts.name);
	const relays = opts.relay?.length ? opts.relay : readRelays(deps.db);
	if (!isCardRelays(relays)) throw new DgCliError(`--relay must be 1 to ${MAX_CARD_RELAYS} wss:// URLs`);
	const { sk } = await ensureNumberKey(deps);
	const selfName = opts.as ?? resolvedSelfName(deps.db);
	const secret = randomBytes(SECRET_BYTES).toString("hex");
	const expiresAt = deps.now() + Math.round(hours * 3600);
	addInvite(deps.db, { secret, expiresAt, asName: selfName, name: opts.name, keyId: numberKeyId(deps.db), relays });
	const card = encodeCard({ npub: npubOf(sk), relays, secret, exp: expiresAt, handle: selfName });
	printJson(deps, {
		card,
		expires_at: isoOf(expiresAt),
		as: selfName,
		handle: opts.name === undefined ? null : `+${opts.name}`,
		safety: PHONE_SAFETY_REF,
	});
	await restartStaleListener(deps, { spawn: true });
}

export async function phoneAccept(
	cardArg: string | undefined,
	textArg: string | undefined,
	deps: PhoneDeps,
	opts: AcceptOpts = {},
): Promise<void> {
	migrateIfNeeded(deps.paths);
	const pasted = cardArg === undefined || cardArg === "-" ? await deps.readStdin() : cardArg;
	if (!pasted) throw new DgCliError("no call card given");
	const card = decodeCard(pasted, deps.now());
	const { handle, existing } = resolveAcceptHandle(deps.db, card.handle, card.npub, opts.name);
	const { keyId, sk } = await signingKeyForAccept(deps, existing, opts.key);
	const selfName = resolvedSelfName(deps.db);
	const words = textArg || "hello";
	if (!existing) {
		const inserted = insertNewContact(deps.db, {
			npub: card.npub,
			handle,
			relays: card.relays,
			keyId,
			addedAt: deps.now(),
			via: "accept",
		});
		if (!inserted) throw new DgCliError("another accept just saved this npub or handle; run the accept again");
	}
	const pool = deps.createPool();
	let relays = card.relays;
	let queried: string[] = [];
	try {
		const event = ring(words, sk, pubkeyHex(card.npub), card.secret, selfName);
		const outgoing = await outgoingRelays(deps, pool, card.relays, card.npub);
		relays = outgoing.relays;
		queried = outgoing.queried;
		const report = await publish(pool, relays, event, { confirmMs: confirmMsFor(deps) });
		if (!shouldSaveOutgoing(report)) {
			if (!existing) removeContact(deps.db, handle);
			throw new DgCliError(rejectedSend("call", report));
		}
		if (existing) addContact(deps.db, { ...existing, relays: card.relays });
		deps.db.addMessage({
			id: event.id,
			direction: "out",
			ts: deps.now(),
			sender: npubOf(sk),
			contact: card.npub,
			text: words,
			call: 1,
		});
		if (!existing) addPhoneNotice(deps.db, `accepted +${handle}`, deps.now());
		await restartStaleListener(deps, { spawn: true });
		printJson(deps, { handle: `+${handle}`, npub: card.npub, id: event.id, ...relayFields(report) });
	} finally {
		closeRelayPool(pool, [...queried, ...relays]);
	}
}

export function phoneContacts(deps: PhoneDeps): void {
	if (!existsSync(PhoneDb.path(deps.paths))) {
		const view = readOnlyLegacyView(deps.paths);
		if (!view.migrationPending) return;
		warnMigrationPending(deps);
		for (const contact of view.contactRows) {
			printJson(deps, {
				handle: `+${contact.handle}`,
				npub: contact.npub,
				relays: contact.relays,
				key: contact.key,
				added_at: null,
				via: "legacy",
			});
		}
		return;
	}
	const notice = latestPhoneNotice(deps.db);
	for (const contact of listContacts(deps.db)) {
		const marker =
			notice === `accepted +${contact.handle}` ? "accepted" : notice === `new contact +${contact.handle}` ? "new" : undefined;
		printJson(deps, {
			handle: `+${contact.handle}`,
			npub: contact.npub,
			relays: contact.relays,
			key: contact.keyId,
			added_at: contact.addedAt,
			via: contact.via,
			...(marker ? { marker } : {}),
		});
	}
}

export function phoneContactsRename(oldHandleArg: string, newHandleArg: string, deps: PhoneDeps): void {
	migrateIfNeeded(deps.paths);
	const oldHandle = normalizeHandle(oldHandleArg);
	const renamed = renameContact(deps.db, oldHandle, normalizeHandle(newHandleArg));
	printJson(deps, { handle: `+${renamed.handle}`, renamed_from: `+${oldHandle}` });
}

export function phoneContactsRemove(handleArg: string, deps: PhoneDeps): void {
	migrateIfNeeded(deps.paths);
	const removed = removeContact(deps.db, normalizeHandle(handleArg));
	printJson(deps, { removed: `+${removed.handle}` });
}

export async function phoneSay(handleArg: string, textArg: string, deps: PhoneDeps): Promise<void> {
	migrateIfNeeded(deps.paths);
	const handle = normalizeHandle(handleArg);
	const contact = findContactByHandle(deps.db, handle);
	if (!contact) throw new DgCliError(`no contact +${handle}`);
	const body = textArg === "-" ? (await deps.readStdin())?.replace(/\n$/, "") : textArg;
	if (!body) throw new DgCliError("message text is empty");
	const sk = (await ensureKey(deps, contact.keyId)).sk;
	const event = wrap(body, sk, pubkeyHex(contact.npub));
	const pool = deps.createPool();
	let relays = contact.relays;
	let queried: string[] = [];
	try {
		const outgoing = await outgoingRelays(deps, pool, contact.relays, contact.npub);
		relays = outgoing.relays;
		queried = outgoing.queried;
		const report = await publish(pool, relays, event, { confirmMs: confirmMsFor(deps) });
		if (!shouldSaveOutgoing(report)) throw new DgCliError(rejectedSend("message", report));
		deps.db.addMessage({
			id: event.id,
			direction: "out",
			ts: deps.now(),
			sender: npubOf(sk),
			contact: contact.npub,
			text: body,
			call: 0,
		});
		await restartStaleListener(deps, { spawn: true });
		printJson(deps, { handle: `+${handle}`, id: event.id, ...relayFields(report) });
	} finally {
		closeRelayPool(pool, [...queried, ...relays]);
	}
}

export function phoneInbox(opts: { n?: string; handle?: string; meta?: boolean }, deps: PhoneDeps): void {
	const limit = opts.n === undefined ? 50 : Number(opts.n);
	if (!Number.isInteger(limit) || limit <= 0) throw new DgCliError(`-n must be a positive integer, got "${opts.n}"`);
	if (!existsSync(PhoneDb.path(deps.paths))) {
		const view = readOnlyLegacyView(deps.paths);
		if (!view.migrationPending) return;
		warnMigrationPending(deps);
		let rows = view.messages;
		if (opts.handle !== undefined) {
			const handle = normalizeHandle(opts.handle);
			if (!view.contactRows.some((contact) => contact.handle === handle)) throw new DgCliError(`no contact +${handle}`);
			rows = rows.filter((row) => row.handle === `+${handle}`);
		}
		for (const row of rows.slice(Math.max(0, rows.length - limit))) {
			printJson(deps, {
				id: row.id,
				ts: row.ts,
				direction: row.direction,
				handle: row.handle,
				from: row.from,
				...(opts.meta ? {} : { text: row.text }),
				read: row.read,
				...(row.call ? { call: true } : {}),
			});
		}
		return;
	}
	let contactNpub: string | undefined;
	if (opts.handle !== undefined) {
		const handle = normalizeHandle(opts.handle);
		const contact = findContactByHandle(deps.db, handle);
		if (!contact) throw new DgCliError(`no contact +${handle}`);
		contactNpub = contact.npub;
	}
	for (const row of deps.db.recentMessages(limit, contactNpub)) {
		const contact = findContactByNpub(deps.db, row.contact);
		printJson(deps, {
			id: row.id,
			ts: row.ts,
			direction: row.direction,
			handle: contact ? `+${contact.handle}` : null,
			from: row.sender,
			...(opts.meta ? {} : { text: row.text }),
			read: row.read_at !== null,
			...(row.call ? { call: true } : {}),
			...(row.sender === PHONE_SYSTEM_SENDER ? { system: true } : {}),
		});
	}
}

function emitUnread(deps: PhoneDeps): void {
	for (const row of deps.db.takeUnread()) {
		const contact = findContactByNpub(deps.db, row.contact);
		printJson(deps, {
			id: row.id,
			ts: row.ts,
			handle: contact ? `+${contact.handle}` : null,
			from: row.sender,
			text: row.text,
			...(row.call ? { call: true } : {}),
			...(row.sender === PHONE_SYSTEM_SENDER ? { system: true } : {}),
		});
	}
}

export async function phoneVoicemail(deps: PhoneDeps): Promise<void> {
	migrateIfNeeded(deps.paths);
	await restartStaleListener(deps, { spawn: true });
	emitUnread(deps);
}

/** Lower and upper bounds of the gap between `watch` checks. The gap is chosen inside this range, never a fixed interval. */
export const WATCH_MIN_DELAY_MS = 2_000;
export const WATCH_MAX_DELAY_MS = 8_000;
export const WATCH_DEFAULT_FOR_S = 120;

export function watchDelayMs(random: () => number): number {
	const span = WATCH_MAX_DELAY_MS - WATCH_MIN_DELAY_MS;
	return WATCH_MIN_DELAY_MS + Math.floor(random() * (span + 1));
}

/** Prints unread voicemail until `for` seconds have passed, sleeping a jittered gap between checks. */
export async function phoneWatch(opts: { for?: string }, deps: PhoneDeps, random: () => number = Math.random): Promise<void> {
	migrateIfNeeded(deps.paths);
	const seconds = opts.for === undefined ? WATCH_DEFAULT_FOR_S : Number(opts.for);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new DgCliError(`--for must be a positive number of seconds, got "${opts.for}"`);
	}
	await restartStaleListener(deps, { spawn: true });
	const deadline = deps.now() + seconds;
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	for (;;) {
		emitUnread(deps);
		const remainingMs = (deadline - deps.now()) * 1000;
		if (remainingMs <= 0) return;
		await sleep(Math.min(watchDelayMs(random), remainingMs));
	}
}

export async function phoneStatus(deps: PhoneDeps): Promise<void> {
	if (!existsSync(PhoneDb.path(deps.paths))) {
		const view = readOnlyLegacyView(deps.paths);
		printJson(deps, {
			as: view.as,
			contacts: view.contacts,
			pending_voicemail: view.pendingVoicemail,
			listener: view.listener
				? { ...view.listener, stale: true, reason: "listener binary version differs" }
				: null,
			hook: null,
			legacy_root_present: false,
			migration_pending: view.migrationPending,
			...(view.migrationPending ? { next: "run phone open to migrate" } : {}),
			autostart: null,
		});
		return;
	}
	const number = readNumber(deps.db);
	const record = readListenerPid(deps.paths);
	let notice = latestPhoneNotice(deps.db);
	let listener: { pid: number; since: number; stale: boolean; reason?: string } | null = null;
	let keysUnreadable = false;
	if (record) {
		const drift = await listenerDrift(deps, record);
		keysUnreadable = Boolean(drift.keysUnreadable);
		if (drift.notice && drift.token) {
			notePhoneDrift(deps.db, drift.token, drift.notice, deps.now());
			notice = latestPhoneNotice(deps.db);
		}
		listener = {
			pid: record.pid,
			since: record.since,
			stale: Boolean(drift.reason),
			...(drift.reason ? { reason: drift.reason } : {}),
		};
	}
	printJson(deps, {
		as: number?.as ?? FALLBACK_SELF_NAME,
		contacts: listContacts(deps.db).length,
		pending_voicemail: deps.db.unreadMessages().filter((row) => row.sender !== PHONE_SYSTEM_SENDER).length,
		listener,
		hook: record?.hook ? { kind: "command" as const, argv: record.hook.argv, timeout_s: record.hook.timeoutS } : null,
		legacy_root_present: legacyRootPresent(deps.paths),
		migration_pending: false,
		notice,
		...(keysUnreadable ? { keys_unreadable: true } : {}),
		autostart: formatAutostartState(readListener(deps.db)?.autostart),
	});
}

export async function phoneRun(opts: { onMessage?: string[]; onMessageTimeout?: string }, deps: RunDeps): Promise<void> {
	migrateIfNeeded(deps.paths);
	await restartStaleListener(deps, { spawn: false });
	const timeoutSeconds = parseOnMessageTimeoutSeconds(opts.onMessageTimeout);
	const hook: CommandPushTarget | undefined = opts.onMessage?.length
		? { kind: "command", argv: opts.onMessage, timeoutMs: Math.round(timeoutSeconds * 1000) }
		: undefined;
	await runListener({ ...deps, hook });
}

function onMessageArgvFor(onMessage: OnMessageConfig | undefined): string[] {
	return onMessage ? ["--on-message", ...onMessage.argv, "--on-message-timeout", String(Math.round(onMessage.timeoutMs / 1000))] : [];
}

function onMessageFromPid(hook: ListenerPid["hook"]): OnMessageConfig | undefined {
	if (!hook) return undefined;
	return { argv: hook.argv, timeoutMs: hook.timeoutS * 1000 };
}

/** Resolves `--on-message`'s executable to an absolute path at `open` time: a systemd user unit
 * carries a minimal `PATH`, so the argv baked into it must not depend on a lookup at run time. */
function resolveOnMessageOpt(
	opts: { onMessage?: string[]; onMessageTimeout?: string },
	deps: Pick<OpenCloseDeps, "which">,
): OnMessageConfig | undefined {
	if (!opts.onMessage?.length) return undefined;
	const timeoutSeconds = parseOnMessageTimeoutSeconds(opts.onMessageTimeout);
	const [exe, ...rest] = opts.onMessage;
	const resolved = deps.which(exe);
	if (!resolved) throw new DgCliError(`--on-message: ${exe} not found on PATH`);
	return { argv: [resolved, ...rest], timeoutMs: Math.round(timeoutSeconds * 1000) };
}

function sameHook(running: { argv: string[]; timeoutS: number } | null | undefined, onMessage: OnMessageConfig | undefined): boolean {
	if (!running || !onMessage) return !running && !onMessage;
	return (
		running.timeoutS === Math.round(onMessage.timeoutMs / 1000) &&
		running.argv.length === onMessage.argv.length &&
		running.argv.every((value, index) => value === onMessage.argv[index])
	);
}

/** The pid file's listener, but only once `isOurListener` confirms it; clears a stale pid file otherwise. */
function liveListener(deps: OpenCloseDeps): ReturnType<typeof readListenerPid> {
	const running = readListenerPid(deps.paths);
	if (!running) return undefined;
	if (deps.isOurListener(running.pid)) return running;
	removeListenerPid(deps.paths);
	return undefined;
}

/** Sends SIGTERM, through `isOurListener`'s extra check against a reused pid, and waits for the
 * listener's own pid file to go away before returning; `open`/`close` both need the old listener
 * fully stopped before installing or reporting on the next one, so neither ever runs two at once. */
async function stopRunningListener(deps: OpenCloseDeps, pid: number): Promise<void> {
	if (deps.isOurListener(pid)) deps.kill(pid, "SIGTERM");
	for (let waited = 0; readListenerPid(deps.paths)?.pid === pid && waited < STOP_WAIT_MS; waited += 100) {
		await deps.sleep(100);
	}
	if (readListenerPid(deps.paths)?.pid === pid) throw new DgCliError(`the phone listener (pid ${pid}) did not stop`);
}

export async function phoneOpen(opts: { onMessage?: string[]; onMessageTimeout?: string }, deps: OpenCloseDeps): Promise<void> {
	migrateIfNeeded(deps.paths);
	const saved = readListener(deps.db);
	const onMessage = resolveOnMessageOpt(opts, deps) ?? saved?.onMessage;

	const running = liveListener(deps);
	const drift = running ? await listenerDrift(deps, running) : undefined;
	// Migration records a listener before login autostart exists. Skip the reuse return in that
	// case so this open installs it, after stopping the detached process, and only one keeps running.
	if (running && running.adopted !== "legacy" && !drift?.restart && sameHook(running.hook, onMessage) && saved?.autostart) {
		if (onMessage) writeListener(deps.db, { ...saved, onMessage });
		printJson(deps, {
			pid: running.pid,
			status: "running",
			autostart: formatAutostartState(saved?.autostart) ?? "unavailable: not installed",
			hook: onMessage ? "command" : null,
		});
		return;
	}
	if (drift?.token && drift.notice) notePhoneDrift(deps.db, drift.token, drift.notice, deps.now());
	let stopped: ListenerPid | undefined;
	if (running) {
		await stopRunningListener(deps, running.pid);
		stopped = running;
	}

	const argv = deps.listenerArgv(onMessageArgvFor(onMessage));
	const status = running ? "restarted" : "started";
	const hookField = onMessage ? ("command" as const) : null;
	let started = false;
	try {
		if (onMessage) writeListener(deps.db, { ...saved, onMessage });
		const install = await installAutostart(deps, deps.paths, { argv, dgHome: deps.env.DG_HOME, logPath: listenerLogPath(deps.paths) });
		started = install.ok;
		writeListener(deps.db, {
			onMessage,
			autostart: install.ok ? { kind: install.kind } : { kind: "unavailable", reason: install.reason },
		});
		if (install.ok) {
			printJson(deps, { pid: null, status, autostart: install.kind, hook: hookField });
			return;
		}
		const pid = deps.spawnListener(argv, listenerLogPath(deps.paths));
		started = true;
		printJson(deps, { pid, status, autostart: `unavailable: ${install.reason}`, hook: hookField });
	} catch (err) {
		// A new listener is already up, so a later bookkeeping error must not start a second one.
		if (stopped && !started) {
			if (saved) writeListener(deps.db, saved);
			else clearListener(deps.db);
			try {
				deps.spawnListener(deps.listenerArgv(onMessageArgvFor(onMessageFromPid(stopped.hook))), listenerLogPath(deps.paths));
			} catch {}
		}
		throw err;
	}
}

export async function phoneClose(deps: OpenCloseDeps): Promise<void> {
	migrateIfNeeded(deps.paths);
	const running = liveListener(deps);

	const autostart = await removeAutostart(deps, deps.paths);
	const saved = readListener(deps.db);
	if (saved?.autostart) writeListener(deps.db, { ...saved, autostart: undefined });

	if (running) await stopRunningListener(deps, running.pid);

	printJson(deps, { pid: running?.pid ?? null, status: "closed", autostart });
}

/** Restarts a listener whose binary or keys drifted. No-ops when this install has never used phone. */
export async function phoneRefresh(deps: OpenCloseDeps): Promise<void> {
	if (!existsSync(PhoneDb.path(deps.paths)) && !legacyRoot(deps.paths)) return;
	migrateIfNeeded(deps.paths);
	if (!existsSync(PhoneDb.path(deps.paths))) return;
	const running = readListenerPid(deps.paths);
	if (!running || running.pid === process.pid || !deps.isOurListener(running.pid)) return;
	const drift = await listenerDrift(deps, running);
	if (!drift.restart) return;
	if (drift.token && drift.notice) notePhoneDrift(deps.db, drift.token, drift.notice, deps.now());
	const saved = readListener(deps.db);
	const kind = saved?.autostart?.kind;
	if (isManagedKind(kind)) {
		for (const argv of managedRestartCommands(kind, deps.uid)) await deps.run(argv);
		return;
	}
	await stopRunningListener(deps, running.pid);
	deps.spawnListener(deps.listenerArgv(onMessageArgvFor(saved?.onMessage)), listenerLogPath(deps.paths));
}

const EXIT_REMOVED_VERB = 2;

/** `phone-friend`'s old verbs that have no new equivalent: each fails outright, naming its replacement. */
const REMOVED_VERBS: Record<string, string> = {
	answer: "answer is gone; run phone open to start the listener, then phone voicemail to read what came in",
	deliver: "deliver is gone; use phone open --on-message to run a program for each message",
	whoami: "whoami is gone; use phone number --as <name>",
	name: "name is gone; use phone contacts rename +old <new>",
};

/** Attaches every phone verb to `group`, plus the hidden one-to-one synonyms `dial`/`on`/`off`/`card` and the removed verbs that fail outright. */
function attachPhoneVerbs(
	group: Command,
	getDeps: () => PhoneDeps,
	getOpenCloseDeps: () => OpenCloseDeps,
): void {
	group
		.command("number")
		.description("print your number card, with your npub, relays, and listener state")
		.option("--as <name>", "self name your card carries, saved for next time")
		.option("--rotate", "roll a new secret, so every card printed before this stops admitting")
		.option("--relay <url...>", "relays your own card should use from now on")
		.action((opts: { as?: string; rotate?: boolean; relay?: string[] }) => phoneNumber(opts, getDeps()));

	group
		.command("invite")
		.description("make a one-time call card; the first ring it admits becomes a new contact")
		.option("--relay <url...>", "relays this card should use instead of the saved ones")
		.option("--ttl <hours>", "hours until the card expires", String(DEFAULT_INVITE_HOURS))
		.option("--as <name>", "self name this card carries instead of your saved one")
		.option("--name <handle>", "handle to give the contact once the call is answered")
		.action((opts: { relay?: string[]; ttl?: string; as?: string; name?: string }) => phoneInvite(opts, getDeps()));

	group
		.command("accept")
		.description("accept a call card: ring its owner and save them as a contact")
		.argument("[card]", "the call card, or - to read it from stdin", "-")
		.argument("[text]", "first words to send", "hello")
		.option("--name <handle>", 'handle for a new contact; required when the card self name is missing, "default", or taken')
		.option("--key <id>", "existing key id to sign a new contact with, instead of the number key")
		.action((card: string, text: string, opts: AcceptOpts) => phoneAccept(card, text, getDeps(), opts));

	const contacts = group
		.command("contacts")
		.description("list every contact, in handle order")
		.action(() => phoneContacts(getDeps()));

	contacts
		.command("rename")
		.argument("<old>", "the contact's current handle")
		.argument("<new>", "the new handle")
		.action((oldHandle: string, newHandle: string) => phoneContactsRename(oldHandle, newHandle, getDeps()));

	contacts
		.command("remove")
		.argument("<handle>", "the contact to remove")
		.action((handle: string) => phoneContactsRemove(handle, getDeps()));

	group
		.command("say")
		.description("send one message to a contact")
		.argument("<handle>", "the contact's handle")
		.argument("<text>", "message text, or - to read it from stdin")
		.action((handle: string, text: string) => phoneSay(handle, text, getDeps()));

	group
		.command("inbox")
		.description("print stored messages, oldest first; never marks anything read")
		.option("-n, --count <count>", "how many messages to print", "50")
		.option("--meta", "print metadata only, omitting message text")
		.argument("[handle]", "limit to one contact's messages")
		.action((handle: string | undefined, opts: { count?: string; meta?: boolean }) =>
			phoneInbox({ n: opts.count, handle, meta: opts.meta }, getDeps()),
		);

	group
		.command("voicemail")
		.description("print unread messages, oldest first, and mark them read")
		.action(() => phoneVoicemail(getDeps()));

	group
		.command("watch")
		.description("print unread voicemail until --for seconds elapse, waiting a jittered gap between checks")
		.option("--for <seconds>", "seconds to keep checking", String(WATCH_DEFAULT_FOR_S))
		.action((opts: { for?: string }) => phoneWatch(opts, getDeps()));

	group
		.command("status")
		.description("print your self name, contact count, and pending voicemail count")
		.action(() => phoneStatus(getDeps()));

	group
		.command("open")
		.description("start the listener and install it to start on login, where a service manager exists")
		.option("--on-message <argv...>", "command and args to run for each delivered message, saved for next time")
		.option("--on-message-timeout <seconds>", "seconds before --on-message is killed", String(DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS))
		.action((opts: { onMessage?: string[]; onMessageTimeout?: string }) => phoneOpen(opts, getOpenCloseDeps()));

	group
		.command("close")
		.description("stop the listener and remove it from login autostart")
		.action(() => phoneClose(getOpenCloseDeps()));

	group
		.command("__refresh", { hidden: true })
		.description("internal: restart a listener whose binary or keys drifted")
		.action(() => phoneRefresh(getOpenCloseDeps()));

	group
		.command("__run", { hidden: true })
		.description("internal: run the always-on listener in the foreground (never call directly)")
		.option("--on-message <argv...>", "command and args to run for each delivered message")
		.option("--on-message-timeout <seconds>", "seconds before --on-message is killed", String(DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS))
		.option("--dg-home <dir>", "state directory for this listener; overrides DG_HOME")
		.action(async (opts: { onMessage?: string[]; onMessageTimeout?: string; dgHome?: string }) => {
			if (opts.dgHome) process.env.DG_HOME = opts.dgHome;
			await phoneRun(opts, { ...getDeps(), pid: process.pid, schedule: defaultSchedule, onSignal: defaultOnSignal });
			process.exit(0);
		});

	group
		.command("dial", { hidden: true })
		.argument("[card]", "the call card, or - to read it from stdin", "-")
		.argument("[text]", "first words to send", "hello")
		.option("--name <handle>", 'handle for a new contact; required when the card self name is missing, "default", or taken')
		.option("--key <id>", "existing key id to sign a new contact with, instead of the number key")
		.action((card: string, text: string, opts: AcceptOpts) => phoneAccept(card, text, getDeps(), opts));

	group
		.command("on", { hidden: true })
		.option("--on-message <argv...>", "command and args to run for each delivered message, saved for next time")
		.option("--on-message-timeout <seconds>", "seconds before --on-message is killed", String(DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS))
		.action((opts: { onMessage?: string[]; onMessageTimeout?: string }) => phoneOpen(opts, getOpenCloseDeps()));

	group
		.command("off", { hidden: true })
		.action(() => phoneClose(getOpenCloseDeps()));

	group
		.command("card", { hidden: true })
		.option("--as <name>", "self name your card carries, saved for next time")
		.option("--rotate", "roll a new secret, so every card printed before this stops admitting")
		.option("--relay <url...>", "relays your own card should use from now on")
		.action((opts: { as?: string; rotate?: boolean; relay?: string[] }) => phoneNumber(opts, getDeps()));

	for (const [verb, message] of Object.entries(REMOVED_VERBS)) {
		group
			.command(verb, { hidden: true })
			.argument("[args...]")
			.action(() => {
				throw new DgCliError(message, EXIT_REMOVED_VERB);
			});
	}
}

export function registerPhoneCommands(
	program: Command,
	makeDeps: (session?: string) => PhoneDeps = defaultDeps,
	makeOpenCloseDeps: (session?: string) => OpenCloseDeps = defaultOpenCloseDeps,
): void {
	let session: string | undefined;

	const group = program
		.command("phone")
		.description("one phone number, many contacts: private NIP-17 chat over public Nostr relays")
		.option("--line <name>", "removed; one phone holds every contact now")
		.hook("preAction", (hooked, action) => {
			({ session } = action.optsWithGlobals<{ session?: string }>());
			if (hooked.getOptionValueSource("line") === "cli") {
				throw new DgCliError("--line is gone: one phone holds every contact; use +handle on say and inbox", EXIT_REMOVED_VERB);
			}
		});
	attachPhoneVerbs(group, () => makeDeps(session), () => makeOpenCloseDeps(session));
}
