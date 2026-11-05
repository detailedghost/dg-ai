import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir, isAlive, readCappedStdin, readCappedStdinBytes, resolveDgPaths, writeFileAtomic, writeStdout } from "@dg/common/node";
import type { Command } from "commander";
import { type AcceptOpts, resolveAcceptHandle, signingKeyForAccept } from "./accept-name";
import { type AutostartDeps, formatAutostartState, installAutostart, managedRestartCommands, removeAutostart } from "./autostart";
import { decodeCard, encodeCard, isCardRelays, MAX_CARD_RELAYS, NO_EXPIRY, SECRET_BYTES } from "./card";
import { ACK_TAG, type ControlRumor, npubOf, PHI_TAG, type PhonePool, PRESENCE_KIND, type PublishReport, publish, RECEIPT_KIND, ring, shouldSaveOutgoing, subscribe, wrap, wrapTagged } from "./chat";
import {
	INBOX_RELAY_CACHE_SECONDS,
	createPhonePool,
	lookupInboxRelays,
	INBOX_RELAY_LOOKUP_MS,
	publishRelaySet,
	resolvePublishConfirmMs,
	PUBLISH_CONFIRM_ENV,
} from "./delivery";
import { type ContactExtRow, type MessageRow, OUTBOX_DIR, PHONE_SYSTEM_SENDER, PhoneDb } from "./db";
import { IMAGE_TEXT, MAX_IMAGE_BYTES, prepareImage, type PreparedImage, storedFile } from "./image";
import type { WormholeDeps } from "./wormhole";
import { defaultVaultClient, PHI_NOT_STORED_TEXT, type VaultClient, vaultPlaceholder } from "./vault";
import { defaultTerminal, type ExecOpts, phoneVaultAdd, phoneVaultExec, phoneVaultList, phoneVaultOpen, phoneVaultRm, readVaultForSend, type Terminal } from "./vault-commands";
import {
	defaultCrontab,
	type CrontabIO,
	ensureCronLine,
	ensureListener,
	installCrontabLine,
	type ListenerVerdict,
	openEnsureArgv,
	ownsEnsureProcess,
	shouldEnsureRestart,
} from "./ensure";
import { defaultKeyClients, ensureKey, type KeyDeps, ensureNumberKey, readFileKey } from "./keys";
import {
	defaultListenerArgv,
	defaultOnSignal,
	listenerArgvFor,
	defaultSchedule,
	holderVerdict,
	ignoreHangup,
	isOurListener,
	listenerDrift,
	listenerLogPath,
	readListenerPid,
	removeListenerPid,
	runListener,
	spawnDetachedListener,
	type ListenerPid,
} from "./listener";
import { acceptControl, applyReceipt, replayGuard } from "./presence";
import { legacyRoot, legacyRootPresent, migrateIfNeeded, readOnlyLegacyView, runArgv } from "./migrate";
import { movePhoneState, rollbackPhoneState } from "./migrate-home";
import { DG_AGENT_PACKAGE_VERSION } from "../version";
import { watchSkipIds } from "./watch";
import {
	behindHandles,
	EXT_TAG,
	FILE_MESSAGE_KIND,
	FROM_EXT_TAG,
	fanoutThread,
	formatBehind,
	MAX_THREAD_MEMBERS,
	type MemberReport,
	parseThreadHandle,
	selfCopyOk,
	senderLabel,
	threadLine,
	threadRoomId,
	threadSendKept,
	threadSendSucceeded,
	type ThreadRecipient,
} from "./thread";
import { parseOnMessageTimeoutSeconds, PHONE_SAFETY_REF, type CommandPushTarget } from "./push";
import { DEFAULT_INVITE_HOURS, type PhoneApi, registerPhoneGroup, WATCH_DEFAULT_FOR_S } from "./register";
import {
	addContact,
	insertNewContact,
	addInvite,
	addPhoneNotice,
	assertContactHandle,
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
	readFilesOn,
	readPresenceOn,
	writePresenceOn,
	gateFor,
	subscriptionRelays,
	readPublishConfirmSetting,
	removeContact,
	renameContact,
	clearListener,
	requireFreeHandle,
	resolvedSelfName,
	selfExtension,
	splitTarget,
	writeFilesOn,
	writeInboxRelayCache,
	writeListener,
	writeNumber,
	writeRelays,
	latestPhoneNotice,
	listContacts,
	notePhoneDrift,
} from "./store";

export { defaultListenerArgv, type ExecOpts, phoneVaultAdd, phoneVaultExec, phoneVaultList, phoneVaultOpen, phoneVaultRm };

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
	wormhole?: WormholeDeps;
	/** Reads under the phone-vault grant; absent means the vault refuses. */
	vaultClient?: () => VaultClient;
	readStdinBytes?: (capBytes: number) => Promise<Buffer | undefined>;
	terminal?: Terminal;
	/** Where `DG_PHONE_AS` is read; absent reads nothing. */
	env?: Record<string, string | undefined>;
};

export type RunDeps = PhoneDeps & {
	pid: number;
	schedule: Parameters<typeof runListener>[0]["schedule"];
	onSignal: Parameters<typeof runListener>[0]["onSignal"];
};

export type OpenCloseDeps = PhoneDeps &
	AutostartDeps & {
		which: (name: string) => string | undefined;
		/** The full argv a unit file or a detached spawn should run; production uses the stable
		 * runtime and lib links through `defaultListenerArgv`, tests fake it with a deterministic path. */
		listenerArgv: (extraArgs: string[]) => string[];
		spawnListener: (argv: string[], logPath: string) => number;
		kill: (pid: number, signal: NodeJS.Signals) => void;
		isOurListener: (pid: number) => boolean;
		sleep: (ms: number) => Promise<void>;
		isAlive?: (pid: number) => boolean;
		verdict?: (pid: number) => ListenerVerdict;
		crontab?: CrontabIO;
	};

const MAX_SEND_BYTES = 64 * 1024;

export type SayOpts = { image?: string; phi?: boolean; vault?: string; as?: string };
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
		readStdinBytes: readCappedStdinBytes,
		vaultClient: defaultVaultClient(paths),
		terminal: defaultTerminal(),
		env: process.env,
		now: () => Math.floor(Date.now() / 1000),
		kill: (pid, signal) => process.kill(pid, signal),
		spawnListener: defaultSpawnListener,
		isOurListener,
		run: runArgv,
		uid: process.getuid?.() ?? 0,
		sleep: (ms) => Bun.sleep(ms),
		listenerArgv: (extraArgs) => listenerArgvFor(paths, extraArgs),
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
		listenerArgv: (extraArgs) => listenerArgvFor(resolveDgPaths(), extraArgs),
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
	timeoutMs?: number,
): Promise<{ relays: string[]; queried: string[] }> {
	const own = readRelays(deps.db);
	const pubkey = pubkeyHex(npub);
	const queried = publishRelaySet({ inbox: [], card: cardRelays, own });
	const inbox = await lookupInboxRelays(
		pool,
		queried,
		pubkey,
		{
			read: () => readInboxRelayCache(deps.db, pubkey, deps.now(), INBOX_RELAY_CACHE_SECONDS),
			write: (relays) => writeInboxRelayCache(deps.db, pubkey, relays, deps.now()),
		},
		timeoutMs,
	);
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
	if (opts.as !== undefined) {
		assertContactHandle(opts.as);
		if (!isHandle(opts.as)) {
			throw new DgCliError(`--as must be 1-32 lowercase letters, digits, or dashes, got "${opts.as}"`);
		}
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
	if (opts.as !== undefined) {
		assertContactHandle(opts.as);
		if (!isHandle(opts.as)) {
			throw new DgCliError(`--as must be 1-32 lowercase letters, digits, or dashes, got "${opts.as}"`);
		}
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
			last_seen: contact.lastSeen === undefined ? null : isoOf(contact.lastSeen),
			...(marker ? { marker } : {}),
			...extensionsField(deps.db.contactExts(contact.npub)),
		});
	}
}

function extensionsField(rows: ContactExtRow[]): { extensions?: { ext: string; last_seen: string }[] } {
	return rows.length > 0 ? { extensions: rows.map((row) => ({ ext: row.ext, last_seen: isoOf(row.last_seen) })) } : {};
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

function selfNames(deps: PhoneDeps): Map<string, string> {
	const label = resolvedSelfName(deps.db);
	const names = new Map<string, string>();
	for (const id of deps.db.listKeyIds()) {
		const sk = readFileKey(deps.db, id);
		if (!sk) continue;
		names.set(npubOf(sk), label);
	}
	return names;
}

function extFields(row: Pick<MessageRow, "direction" | "ext" | "peer_ext">): { ext?: string; from_ext?: string } {
	return { ...(row.ext ? { ext: row.ext } : {}), ...(row.direction === "in" && row.peer_ext ? { from_ext: row.peer_ext } : {}) };
}

function emitStored(
	deps: PhoneDeps,
	row: MessageRow,
	self: Map<string, string>,
	fields: { direction: boolean; read: boolean; meta: boolean },
): void {
	const file = fields.meta ? undefined : storedFile(row, deps.paths.phoneRoot);
	if (row.thread_id) {
		const thread = deps.db.getThread(row.thread_id);
		const threadHandle = thread?.handle ?? `#${row.thread_id.slice(0, 8)}`;
		const contact = findContactByNpub(deps.db, row.sender);
		const label = extHandle(senderLabel(row.sender, contact?.handle, self.get(row.sender)), row.peer_ext);
		printJson(deps, {
			id: row.id,
			ts: row.ts,
			...(fields.direction ? { direction: row.direction } : {}),
			thread: threadHandle,
			handle: label,
			from: row.sender,
			...extFields(row),
			...(fields.meta ? {} : { text: row.text, line: threadLine(threadHandle, label, row.text) }),
			...(file ? { file } : {}),
			...(fields.read ? { read: row.read_at !== null } : {}),
			...(row.direction === "out" ? { delivered: row.delivered_at !== null } : {}),
			...(row.call ? { call: true } : {}),
			...(row.sender === PHONE_SYSTEM_SENDER ? { system: true } : {}),
		});
		return;
	}
	const contact = findContactByNpub(deps.db, row.contact);
	printJson(deps, {
		id: row.id,
		ts: row.ts,
		...(fields.direction ? { direction: row.direction } : {}),
		handle: contact ? extHandle(`+${contact.handle}`, row.peer_ext) : null,
		from: row.sender,
		...extFields(row),
		...(fields.meta ? {} : { text: row.text }),
		...(file ? { file } : {}),
		...(fields.read ? { read: row.read_at !== null } : {}),
		...(row.direction === "out" ? { delivered: row.delivered_at !== null } : {}),
		...(row.call ? { call: true } : {}),
		...(row.sender === PHONE_SYSTEM_SENDER ? { system: true } : {}),
	});
}

export function phoneThreadNew(
	handleArg: string,
	memberArgs: string[],
	opts: { subject?: string },
	deps: PhoneDeps,
): Promise<void> {
	return phoneThreadNewAt(handleArg, memberArgs, opts, deps);
}

async function phoneThreadNewAt(
	handleArg: string,
	memberArgs: string[],
	opts: { subject?: string },
	deps: PhoneDeps,
): Promise<void> {
	migrateIfNeeded(deps.paths);
	const handle = parseThreadHandle(handleArg);
	if (deps.db.getThreadByHandle(handle)) throw new DgCliError(`"${handle}" is already a group`);
	if (memberArgs.length === 0) throw new DgCliError("name at least one contact");
	if (memberArgs.length + 1 > MAX_THREAD_MEMBERS) {
		throw new DgCliError(`a group can have at most ${MAX_THREAD_MEMBERS} members`);
	}
	if (opts.subject !== undefined && opts.subject.trim() === "") throw new DgCliError("subject is empty");
	const subject = opts.subject ?? "";
	const members = memberArgs.map((arg) => {
		if (arg.startsWith("#")) throw new DgCliError(`a group member must be a contact, got "${arg}"`);
		const memberHandle = normalizeHandle(arg);
		const contact = findContactByHandle(deps.db, memberHandle);
		if (!contact) throw new DgCliError(`no contact +${memberHandle}`);
		return contact;
	});
	const seenNpubs = new Set<string>();
	for (const member of members) {
		if (seenNpubs.has(member.npub)) throw new DgCliError(`+${member.handle} is listed more than once`);
		seenNpubs.add(member.npub);
	}
	const keyId = members[0]?.keyId;
	if (keyId === undefined || members.some((member) => member.keyId !== keyId)) {
		throw new DgCliError("group members must share one key");
	}
	const loaded = await ensureKey(deps, keyId);
	const selfNpub = npubOf(loaded.sk);
	if (members.some((member) => member.npub === selfNpub)) throw new DgCliError("a group already includes you");
	const id = threadRoomId([selfNpub, ...members.map((member) => member.npub)]);
	if (deps.db.getThread(id)) throw new DgCliError(`a group with these members already exists: ${deps.db.getThread(id)?.handle}`);
	const createdAt = deps.now();
	deps.db.transaction(() => {
		deps.db.insertThread({ id, handle, subject, key_id: keyId, created_at: createdAt, via: "local" });
		deps.db.insertThreadMember(id, selfNpub);
		for (const member of members) deps.db.insertThreadMember(id, member.npub);
	});
	printJson(deps, {
		handle,
		id,
		subject,
		members: [`+${resolvedSelfName(deps.db)}`, ...members.map((member) => `+${member.handle}`)],
		key: keyId,
	});
}

export function phoneThreadList(deps: PhoneDeps): void {
	const self = selfNames(deps);
	for (const thread of deps.db.listThreads()) {
		const npubs = deps.db.listThreadMemberNpubs(thread.id);
		printJson(deps, {
			handle: thread.handle,
			id: thread.id,
			subject: thread.subject,
			key: thread.key_id,
			created_at: thread.created_at,
			via: thread.via,
			members: npubs.map((npub) => senderLabel(npub, findContactByNpub(deps.db, npub)?.handle, self.get(npub))),
		});
	}
}

export function phoneThreadShow(handleArg: string, deps: PhoneDeps): void {
	const handle = parseThreadHandle(handleArg);
	const thread = deps.db.getThreadByHandle(handle);
	if (!thread) throw new DgCliError(`no group ${handle}`);
	const self = selfNames(deps);
	printJson(deps, {
		handle: thread.handle,
		id: thread.id,
		subject: thread.subject,
		key: thread.key_id,
		created_at: thread.created_at,
		via: thread.via,
		members: deps.db.listThreadMemberNpubs(thread.id).map((npub) => {
			const mine = self.get(npub);
			return {
				npub,
				handle: senderLabel(npub, findContactByNpub(deps.db, npub)?.handle, mine),
				...(mine !== undefined ? { self: true } : {}),
			};
		}),
	});
}

/** Checks every `--image` gate in contract order, then strips and seals the file; undefined for a text say. */
function prepareImageSend(textArg: string | undefined, opts: SayOpts, deps: PhoneDeps): PreparedImage | undefined {
	if (opts.image === undefined) return undefined;
	if (!readFilesOn(deps.db)) throw new DgCliError("files are off; the human runs phone files on");
	if (textArg) throw new DgCliError("--image takes no text; send text with a second text command");
	const stat = statSync(opts.image, { throwIfNoEntry: false });
	if (!stat) throw new DgCliError(`no file at ${opts.image}`);
	if (!stat.isFile()) throw new DgCliError("not an image");
	if (stat.size > MAX_IMAGE_BYTES) throw new DgCliError("image is larger than 5 MiB");
	const bytes = readFileSync(opts.image);
	if (bytes.length > MAX_IMAGE_BYTES) throw new DgCliError("image is larger than 5 MiB");
	return prepareImage(bytes);
}

/** Writes the ciphertext and who may fetch it before any wrap goes out, so a fast receiver is not refused; returns the undo. */
function stageOutbox(deps: PhoneDeps, image: PreparedImage, keyId: string, recipients: readonly string[], phi: boolean): () => void {
	const dir = join(deps.paths.phoneRoot, OUTBOX_DIR);
	ensurePrivateDir(dir);
	const path = join(dir, image.x);
	writeFileAtomic(path, image.cipher, 0o600);
	deps.db.addOutbox(image.x, keyId, recipients, { phi });
	return () => {
		rmSync(path, { force: true });
		deps.db.removeOutbox(image.x);
	};
}

function dropMissedRecipients(deps: PhoneDeps, x: string, members: readonly MemberReport[]): void {
	for (const member of members) {
		if (!member.self && member.relays_ok.length === 0 && member.relays_unconfirmed.length === 0) deps.db.removeOutboxRecipient(x, pubkeyHex(member.npub));
	}
}

/** Where a send is addressed on the far machine and which agent here sent it. */
type Route = { ext?: string; fromExt?: string };

function routeTags(route: Route): string[][] {
	return [...(route.ext ? [[EXT_TAG, route.ext]] : []), ...(route.fromExt ? [[FROM_EXT_TAG, route.fromExt]] : [])];
}

function rumorTags(image: PreparedImage | undefined, phi: boolean, route: Route): string[][] {
	return [...(image?.tags ?? []), ...(phi ? [[PHI_TAG, "1"]] : []), ...routeTags(route)];
}

function extHandle(handle: string, ext: string | null | undefined): string {
	return ext ? `${handle}/${ext}` : handle;
}

async function readSayBody(textArg: string | undefined, deps: PhoneDeps): Promise<string> {
	const body = textArg === "-" ? (await deps.readStdin())?.replace(/\n$/, "") : textArg;
	if (!body) throw new DgCliError("message text is empty");
	return body;
}

/** What one send carries, and what its own row keeps: never PHI, only a placeholder for it. */
type Outgoing = { image?: PreparedImage; phi: boolean; vault?: string };

async function prepareOutgoing(textArg: string | undefined, opts: SayOpts, deps: PhoneDeps): Promise<Outgoing & { text?: string }> {
	if (opts.vault === undefined) return { image: prepareImageSend(textArg, opts, deps), phi: opts.phi === true };
	if (opts.image !== undefined) throw new DgCliError("--vault and --image cannot be used together");
	if (textArg !== undefined) throw new DgCliError("--vault takes no text");
	const item = await readVaultForSend(opts.vault, deps);
	if (item.kind === "text") {
		if (Buffer.byteLength(item.text) > MAX_SEND_BYTES) throw new DgCliError("vault item is over 64 KiB, too large to send as text");
		return { text: item.text, phi: true, vault: opts.vault };
	}
	if (!readFilesOn(deps.db)) throw new DgCliError("files are off; the human runs phone files on");
	return { image: prepareImage(item.plain), phi: true, vault: opts.vault };
}

function saveOutgoing(
	deps: PhoneDeps,
	row: { id: string; ts: number; sender: string; contact: string; text: string; thread_id?: string; ext?: string; peer_ext?: string },
	sent: Outgoing,
): void {
	const stored = sent.vault !== undefined
		? { text: vaultPlaceholder(sent.vault), file: null }
		: sent.image
			? { text: IMAGE_TEXT, file: JSON.stringify(sent.image.file) }
			: { text: sent.phi ? PHI_NOT_STORED_TEXT : row.text, file: null };
	deps.db.addMessage({ ...row, direction: "out", call: 0, ...stored, phi: sent.phi });
}

export function phonePresence(state: string | undefined, deps: PhoneDeps): void {
	if (state !== undefined && state !== "on" && state !== "off") throw new DgCliError(`presence takes on or off, got "${state}"`);
	if (state !== undefined) writePresenceOn(deps.db, state === "on");
	printJson(deps, { presence: readPresenceOn(deps.db) ? "on" : "off" });
}

export function phoneFiles(state: string | undefined, deps: PhoneDeps): void {
	if (state !== undefined && state !== "on" && state !== "off") throw new DgCliError(`files takes on or off, got "${state}"`);
	if (state !== undefined) writeFilesOn(deps.db, state === "on");
	printJson(deps, { files: readFilesOn(deps.db) ? "on" : "off" });
}

async function phoneSayThread(
	handleArg: string,
	textArg: string | undefined,
	deps: PhoneDeps,
	sent: Outgoing & { text?: string },
	fromExt: string | undefined,
): Promise<void> {
	const { image, phi } = sent;
	const handle = parseThreadHandle(handleArg);
	const thread = deps.db.getThreadByHandle(handle);
	if (!thread) throw new DgCliError(`no group ${handle}`);
	const body = image ? image.content : (sent.text ?? (await readSayBody(textArg, deps)));
	const loaded = await ensureKey(deps, thread.key_id);
	const selfNpub = npubOf(loaded.sk);
	const others = deps.db.listThreadMemberNpubs(thread.id).filter((npub) => npub !== selfNpub);
	const recipients: ThreadRecipient[] = [];
	for (const npub of others) {
		const contact = findContactByNpub(deps.db, npub);
		if (!contact) throw new DgCliError(`group member ${npub.slice(0, 16)} is not a contact`);
		recipients.push({ handle: `+${contact.handle}`, npub, pub: pubkeyHex(npub), self: false });
	}
	recipients.push({ handle: `+${resolvedSelfName(deps.db)}`, npub: selfNpub, pub: pubkeyHex(selfNpub), self: true });
	const peerPubs = recipients.filter((recipient) => !recipient.self).map((recipient) => recipient.pub);
	const unstage = image ? stageOutbox(deps, image, thread.key_id, peerPubs, phi) : undefined;
	const pool = deps.createPool();
	const relaysUsed: string[] = [];
	const createdAt = deps.now();
	try {
		const delivered = await fanoutThread({
			sk: loaded.sk,
			text: body,
			kind: image ? FILE_MESSAGE_KIND : undefined,
			extraTags: rumorTags(image, phi, { fromExt }),
			createdAt,
			subject: thread.subject,
			fallbackSubject: handle.slice(1),
			recipients,
			relaysFor: async (recipient) => {
				const card = recipient.self ? readRelays(deps.db) : (findContactByNpub(deps.db, recipient.npub)?.relays ?? []);
				const outgoing = await outgoingRelays(deps, pool, card, recipient.npub);
				relaysUsed.push(...outgoing.queried, ...outgoing.relays);
				return outgoing.relays;
			},
			publishTo: (relays, event) => publish(pool, relays, event, { confirmMs: confirmMsFor(deps) }),
		}).catch((err: unknown) => {
			unstage?.();
			throw err;
		});
		const behind = behindHandles(delivered.members);
		const kept = threadSendKept(delivered.members);
		if (kept) {
			if (image) dropMissedRecipients(deps, image.x, delivered.members);
			saveOutgoing(
				deps,
				{ id: delivered.rumorId, ts: createdAt, sender: selfNpub, contact: selfNpub, text: body, thread_id: thread.id },
				sent,
			);
			await restartStaleListener(deps, { spawn: true });
		} else {
			unstage?.();
		}
		const payload = {
			handle,
			id: delivered.rumorId,
			members: delivered.members.map((member) => ({
				handle: member.handle,
				npub: member.npub,
				relays_ok: member.relays_ok,
				relays_unconfirmed: member.relays_unconfirmed,
				relays_failed: member.relays_failed,
			})),
			behind,
			self_ok: selfCopyOk(delivered.members),
			delivered: false,
		};
		if (!threadSendSucceeded(delivered.members)) {
			if (kept) printJson(deps, payload);
			throw new DgCliError(behind.length > 0 ? `members behind: ${behind.join(", ")}` : formatBehind(delivered.members));
		}
		printJson(deps, payload);
	} finally {
		closeRelayPool(pool, relaysUsed);
	}
}

export async function phoneSay(handleArg: string, textArg: string | undefined, deps: PhoneDeps, opts: SayOpts = {}): Promise<void> {
	migrateIfNeeded(deps.paths);
	const { target, ext } = splitTarget(handleArg);
	const fromExt = selfExtension(opts.as, deps.env ?? {});
	const sent = await prepareOutgoing(textArg, opts, deps);
	const { image, phi } = sent;
	if (target.startsWith("#")) return phoneSayThread(target, textArg, deps, sent, fromExt);
	const handle = normalizeHandle(target);
	const contact = findContactByHandle(deps.db, handle);
	if (!contact) throw new DgCliError(`no contact +${handle}`);
	const body = image ? image.content : (sent.text ?? (await readSayBody(textArg, deps)));
	const sk = (await ensureKey(deps, contact.keyId)).sk;
	const contactPub = pubkeyHex(contact.npub);
	const tags = rumorTags(image, phi, { ext, fromExt });
	const event =
		tags.length > 0 ? wrapTagged({ kind: image ? FILE_MESSAGE_KIND : undefined, content: body, tags }, sk, contactPub) : wrap(body, sk, contactPub);
	const unstage = image ? stageOutbox(deps, image, contact.keyId, [contactPub], phi) : undefined;
	const pool = deps.createPool();
	let relays = contact.relays;
	let queried: string[] = [];
	try {
		let report: PublishReport;
		try {
			const outgoing = await outgoingRelays(deps, pool, contact.relays, contact.npub);
			relays = outgoing.relays;
			queried = outgoing.queried;
			report = await publish(pool, relays, event, { confirmMs: confirmMsFor(deps) });
			if (!shouldSaveOutgoing(report)) throw new DgCliError(rejectedSend("message", report));
		} catch (err) {
			unstage?.();
			throw err;
		}
		saveOutgoing(deps, { id: event.id, ts: deps.now(), sender: npubOf(sk), contact: contact.npub, text: body, ext: fromExt, peer_ext: ext }, sent);
		await restartStaleListener(deps, { spawn: true });
		printJson(deps, { handle: extHandle(`+${handle}`, ext), id: event.id, ...relayFields(report), delivered: false });
	} finally {
		closeRelayPool(pool, [...queried, ...relays]);
	}
}

const PING_DEFAULT_TIMEOUT_S = 30;
const PING_MAX_TIMEOUT_S = 600;
const PING_POLL_MS = 250;

type PingTarget = { npub: string; relays: string[] };

function pingTargets(handleArg: string, deps: PhoneDeps): { handle: string; keyId: string; targets: PingTarget[]; ext?: string } {
	const { target, ext } = splitTarget(handleArg);
	if (target.startsWith("#")) {
		const handle = parseThreadHandle(target);
		const thread = deps.db.getThreadByHandle(handle);
		if (!thread) throw new DgCliError(`no group ${handle}`);
		const targets = deps.db
			.listThreadMemberNpubs(thread.id)
			.map((npub) => findContactByNpub(deps.db, npub))
			.filter((contact) => contact !== undefined)
			.map((contact) => ({ npub: contact.npub, relays: contact.relays }));
		return { handle, keyId: thread.key_id, targets };
	}
	const handle = normalizeHandle(target);
	const contact = findContactByHandle(deps.db, handle);
	if (!contact) throw new DgCliError(`no contact +${handle}`);
	return { handle: extHandle(`+${handle}`, ext), keyId: contact.keyId, targets: [{ npub: contact.npub, relays: contact.relays }], ext };
}

function listenerServes(deps: PhoneDeps): boolean {
	return readListenerPid(deps.paths)?.version === DG_AGENT_PACKAGE_VERSION;
}

/** Sends a check to a contact or each thread member and waits for the first receipt; exit 1 when none comes in time. */
export async function phonePing(handleArg: string, opts: { timeout?: string }, deps: PhoneDeps): Promise<void> {
	migrateIfNeeded(deps.paths);
	const seconds = opts.timeout === undefined ? PING_DEFAULT_TIMEOUT_S : Number(opts.timeout);
	if (!Number.isFinite(seconds) || seconds < 1 || seconds > PING_MAX_TIMEOUT_S) {
		throw new DgCliError(`--timeout must be a number of seconds from 1 to ${PING_MAX_TIMEOUT_S}, got "${opts.timeout}"`);
	}
	const { handle, keyId, targets, ext } = pingTargets(handleArg, deps);
	const loaded = await ensureKey(deps, keyId);
	const key = { id: keyId, pub: pubkeyHex(npubOf(loaded.sk)), sk: loaded.sk };
	const selfNpub = npubOf(loaded.sk);
	const pool = deps.createPool();
	const relaysUsed: string[] = [];
	const sentAt = deps.now();
	const seen = replayGuard();
	const listenRelays = subscriptionRelays(deps.db);
	const gate = gateFor(deps.db);
	const own = listenerServes(deps)
		? undefined
		: subscribe(
				pool,
				listenRelays,
				[key],
				() => gate,
				{ cursor: sentAt, ids: [] },
				() => {},
				deps.now,
				{
					onControl: (control: ControlRumor) => {
						if (control.kind === RECEIPT_KIND && acceptControl(deps.db, seen, control, deps.now())) applyReceipt(deps.db, control, [key], deps.now());
					},
				},
			);
	if (own) relaysUsed.push(...listenRelays);
	const deadline = sentAt + seconds;
	const endMs = Date.now() + seconds * 1000;
	const remainingMs = () => Math.max(0, endMs - Date.now());
	const ids: string[] = [];
	let finished = false;
	let sent = false;
	try {
		void (async () => {
			for (const target of targets) {
				if (finished || remainingMs() === 0) return;
				const event = wrapTagged(
					{ kind: PRESENCE_KIND, content: "", tags: [[ACK_TAG, "1"], ["n", randomBytes(16).toString("hex")], ...routeTags({ ext })] },
					loaded.sk,
					pubkeyHex(target.npub),
				);
				deps.db.addPing({ id: event.id, contact: target.npub, sender: selfNpub, sent_at: sentAt });
				ids.push(event.id);
				const outgoing = await outgoingRelays(deps, pool, target.relays, target.npub, Math.min(INBOX_RELAY_LOOKUP_MS, remainingMs()));
				if (finished) return closeRelayPool(pool, outgoing.queried);
				relaysUsed.push(...outgoing.queried, ...outgoing.relays);
				await publish(pool, outgoing.relays, event, { confirmMs: Math.min(confirmMsFor(deps), remainingMs()), confirmById: false });
			}
		})()
			.catch(() => undefined)
			.finally(() => {
				sent = true;
			});
		const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
		const inTime = (at: number | null | undefined): at is number => typeof at === "number" && at <= deadline;
		const busy = () => {
			printJson(deps, { handle, delivered: false, busy: true, after_s: Math.max(0, deps.now() - sentAt), line: "busy, try later" });
			process.exitCode = 1;
		};
		for (let waited = 0; ; waited += sent ? PING_POLL_MS : 0) {
			const rows = ids.map((id) => deps.db.pingRow(id));
			const delivered = rows.map((row) => row?.delivered_at).filter(inTime);
			if (delivered.length > 0) {
				const after = Math.max(0, Math.min(...delivered) - sentAt);
				printJson(deps, { handle, delivered: true, after_s: after, line: `delivered after ${after} s` });
				return;
			}
			if (rows.length === targets.length && rows.length > 0 && rows.every((row) => inTime(row?.busy_at))) return busy();
			if (waited >= seconds * 1000 || deps.now() > deadline || remainingMs() === 0) break;
			await sleep(PING_POLL_MS);
		}
		if (ids.some((id) => inTime(deps.db.pingRow(id)?.busy_at))) return busy();
		printJson(deps, { handle, delivered: false, after_s: seconds, line: `no answer after ${seconds} s` });
		process.exitCode = 1;
	} finally {
		finished = true;
		own?.close();
		closeRelayPool(pool, relaysUsed);
	}
}

/** One line naming how many unread rows wait for each agent, so the shared view never hides them silently. */
function printWaiting(deps: PhoneDeps): void {
	const waiting = deps.db.waitingByExtension();
	const names = Object.keys(waiting);
	if (names.length === 0) return;
	const total = names.reduce((sum, name) => sum + (waiting[name] ?? 0), 0);
	const counts = names.map((name) => `${name} ${waiting[name]}`).join(", ");
	printJson(deps, { waiting, line: `${total} unread for other agents: ${counts}; read them with --as <ext>` });
}

export function phoneInbox(opts: { n?: string; handle?: string; meta?: boolean; as?: string }, deps: PhoneDeps): void {
	const ext = selfExtension(opts.as, deps.env ?? {});
	const view = { ext: ext ?? null };
	const limit = opts.n === undefined ? 50 : Number(opts.n);
	if (!Number.isInteger(limit) || limit <= 0) throw new DgCliError(`-n must be a positive integer, got "${opts.n}"`);
	if (!existsSync(PhoneDb.path(deps.paths))) {
		const view = readOnlyLegacyView(deps.paths);
		if (!view.migrationPending) return;
		warnMigrationPending(deps);
		let rows = view.messages;
		if (opts.handle !== undefined) {
			if (opts.handle.startsWith("#")) throw new DgCliError(`no group ${opts.handle}`);
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
	const self = selfNames(deps);
	if (opts.handle?.startsWith("#")) {
		const handle = parseThreadHandle(opts.handle);
		const thread = deps.db.getThreadByHandle(handle);
		if (!thread) throw new DgCliError(`no group ${handle}`);
		for (const row of deps.db.recentMessages(limit, undefined, thread.id, view)) {
			emitStored(deps, row, self, { direction: true, read: true, meta: opts.meta === true });
		}
		return;
	}
	let contactNpub: string | undefined;
	if (opts.handle !== undefined) {
		const handle = normalizeHandle(splitTarget(opts.handle).target);
		const contact = findContactByHandle(deps.db, handle);
		if (!contact) throw new DgCliError(`no contact +${handle}`);
		contactNpub = contact.npub;
	}
	for (const row of deps.db.recentMessages(limit, contactNpub, undefined, view)) {
		emitStored(deps, row, self, { direction: true, read: true, meta: opts.meta === true });
	}
	if (!ext) printWaiting(deps);
}

function emitUnread(deps: PhoneDeps, ext: string | undefined, skip?: ReadonlySet<string>): void {
	const self = selfNames(deps);
	for (const row of deps.db.takeUnreadFor(ext ?? null, skip)) {
		emitStored(deps, row, self, { direction: false, read: false, meta: false });
	}
}

export async function phoneVoicemail(deps: PhoneDeps, opts: { as?: string } = {}): Promise<void> {
	const ext = selfExtension(opts.as, deps.env ?? {});
	migrateIfNeeded(deps.paths);
	await restartStaleListener(deps, { spawn: true });
	emitUnread(deps, ext);
	if (!ext) printWaiting(deps);
}

/** Lower and upper bounds of the gap between `watch` checks. The gap is chosen inside this range, never a fixed interval. */
export const WATCH_MIN_DELAY_MS = 2_000;
export const WATCH_MAX_DELAY_MS = 8_000;

export function watchDelayMs(random: () => number): number {
	const span = WATCH_MAX_DELAY_MS - WATCH_MIN_DELAY_MS;
	return WATCH_MIN_DELAY_MS + Math.floor(random() * (span + 1));
}

/** Prints unread voicemail until `for` seconds have passed, sleeping a jittered gap between checks.
 * The backlog is printed unless `--new` is set, so a message that arrived between two polls is not skipped. */
export async function phoneWatch(
	opts: { for?: string; new?: boolean; as?: string },
	deps: PhoneDeps,
	random: () => number = Math.random,
): Promise<void> {
	const ext = selfExtension(opts.as, deps.env ?? {});
	migrateIfNeeded(deps.paths);
	const seconds = opts.for === undefined ? WATCH_DEFAULT_FOR_S : Number(opts.for);
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new DgCliError(`--for must be a positive number of seconds, got "${opts.for}"`);
	}
	await restartStaleListener(deps, { spawn: true });
	const skip = watchSkipIds(
		deps.db.unreadFor(ext ?? null).map((row) => row.id),
		opts.new === true,
	);
	const deadline = deps.now() + seconds;
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	for (;;) {
		emitUnread(deps, ext, skip);
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
		pending_voicemail:
			deps.db.unreadFor(null).filter((row) => row.sender !== PHONE_SYSTEM_SENDER).length +
			Object.values(deps.db.waitingByExtension()).reduce((sum, count) => sum + count, 0),
		listener,
		hook: record?.hook ? { kind: "command" as const, argv: record.hook.argv, timeout_s: record.hook.timeoutS } : null,
		legacy_root_present: legacyRootPresent(deps.paths),
		migration_pending: false,
		notice,
		...(keysUnreadable ? { keys_unreadable: true } : {}),
		autostart: formatAutostartState(readListener(deps.db)?.autostart),
		files: readFilesOn(deps.db) ? "on" : "off",
		presence: readPresenceOn(deps.db) ? "on" : "off",
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
async function stopRunningListener(deps: OpenCloseDeps, pid: number, paths: DgPaths = deps.paths): Promise<void> {
	if (deps.isOurListener(pid)) deps.kill(pid, "SIGTERM");
	for (let waited = 0; readListenerPid(paths)?.pid === pid && waited < STOP_WAIT_MS; waited += 100) {
		await deps.sleep(100);
	}
	if (readListenerPid(paths)?.pid === pid) throw new DgCliError(`the phone listener (pid ${pid}) did not stop`);
}

async function phoneOpenEnsure(
	opts: { onMessage?: string[]; onMessageTimeout?: string; ensure?: boolean; printCron?: boolean; installCron?: boolean },
	deps: OpenCloseDeps,
): Promise<void> {
	const cron = opts.printCron || opts.installCron ? ensureCronLine(openEnsureArgv(deps.listenerArgv), deps.env.DG_HOME) : undefined;
	if (opts.installCron && cron) await installCrontabLine(cron, deps.crontab ?? defaultCrontab());
	if (!opts.ensure) {
		printJson(deps, { ...(cron ? { cron } : {}), ...(opts.installCron ? { cron_installed: true } : {}) });
		return;
	}
	const saved = readListener(deps.db);
	const onMessage = resolveOnMessageOpt(opts, deps) ?? saved?.onMessage;
	if (onMessage) writeListener(deps.db, { ...saved, onMessage });
	let restarted = false;
	const running = readListenerPid(deps.paths);
	if (running && deps.isOurListener(running.pid)) {
		const drift = await listenerDrift(deps, running);
		if (drift.restart && shouldEnsureRestart(DG_AGENT_PACKAGE_VERSION, running.version)) {
			restarted = true;
			if (drift.token && drift.notice) notePhoneDrift(deps.db, drift.token, drift.notice, deps.now());
			await stopRunningListener(deps, running.pid);
		}
	}
	const listenerArgv = deps.listenerArgv(onMessageArgvFor(onMessage));
	const ensured = await ensureListener({
		paths: deps.paths,
		now: deps.now,
		nowMs: () => Date.now(),
		sleep: deps.sleep,
		isAlive: deps.isAlive ?? isAlive,
		verdict: deps.verdict ?? ((pid) => holderVerdict(pid)),
		ownsProcess: (pid) => ownsEnsureProcess(pid, listenerArgv[0]),
		argv: listenerArgv,
		hook: onMessage ? { argv: onMessage.argv, timeoutS: Math.round(onMessage.timeoutMs / 1000) } : null,
		spawnListener: deps.spawnListener,
	});
	printJson(deps, {
		pid: ensured.pid,
		status: restarted && ensured.status === "started" ? "restarted" : ensured.status,
		autostart: "ensure",
		hook: onMessage ? "command" : null,
		...(cron ? { cron } : {}),
		...(opts.installCron ? { cron_installed: true } : {}),
	});
}

export async function phoneOpen(
	opts: { onMessage?: string[]; onMessageTimeout?: string; ensure?: boolean; printCron?: boolean; installCron?: boolean },
	deps: OpenCloseDeps,
): Promise<void> {
	migrateIfNeeded(deps.paths);
	if (opts.ensure || opts.printCron || opts.installCron) {
		await phoneOpenEnsure(opts, deps);
		return;
	}
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

/**
 * Moves phone state out of the old flat home into the state dir, stopping a listener that runs from
 * there first. Returns true when a listener was running, so the caller starts it from the new layout.
 */
export async function moveLegacyPhoneHome(deps: OpenCloseDeps): Promise<boolean> {
	const oldRoot = join(deps.paths.legacyHome, "phone");
	if (oldRoot === deps.paths.phoneRoot || !existsSync(oldRoot) || existsSync(deps.paths.phoneRoot)) return false;
	const oldPaths = { ...deps.paths, phoneRoot: oldRoot };
	const running = readListenerPid(oldPaths);
	const live = !!running && running.pid !== process.pid && deps.isOurListener(running.pid);
	if (running && live) await stopRunningListener(deps, running.pid, oldPaths);
	const log = (line: string) => (deps.writeErr ?? ((text: string) => process.stderr.write(text)))(`${line}\n`);
	const moved = movePhoneState(oldRoot, deps.paths.phoneRoot, log).moved;
	if (live && !moved)
		log(`dg: stopped the phone listener at ${oldRoot}, and its state did not move. Fix the cause above, then run dg-skills install again`);
	return moved && live;
}

/** Copies phone state back to the old flat home so an older release can read it. */
export function phoneRollbackHome(deps: PhoneDeps): void {
	const running = readListenerPid(deps.paths);
	if (running && running.pid !== process.pid && (deps.isOurListener ?? isOurListener)(running.pid))
		throw new DgCliError(
			"the phone listener is running; stop it with dg-agent phone close, then run dg-agent phone __rollback-home again",
		);
	const log = (line: string) => (deps.writeErr ?? ((text: string) => process.stderr.write(text)))(`${line}\n`);
	const result = rollbackPhoneState(deps.paths.phoneRoot, join(deps.paths.legacyHome, "phone"), log);
	if (!result.moved) throw new DgCliError(`phone state was not copied back: ${result.failures.join("; ")}`);
}

/** Restarts a listener whose binary or keys drifted. No-ops when this install has never used phone. */
export async function phoneRefresh(deps: OpenCloseDeps): Promise<void> {
	if (await moveLegacyPhoneHome(deps)) {
		await phoneOpen({}, deps);
		return;
	}
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

export const defaultPhoneApi: PhoneApi = {
	phoneNumber,
	phoneInvite,
	phoneAccept,
	phoneContacts,
	phoneContactsRename,
	phoneContactsRemove,
	phoneFiles,
	phonePresence,
	phoneSay,
	phonePing,
	phoneInbox,
	phoneVoicemail,
	phoneWatch,
	phoneStatus,
	phoneOpen,
	phoneClose,
	phoneRefresh,
	phoneRollbackHome,
	phoneRun,
	phoneThreadNew,
	phoneThreadList,
	phoneThreadShow,
	phoneVaultAdd,
	phoneVaultList,
	phoneVaultRm,
	phoneVaultOpen,
	phoneVaultExec,
	ignoreHangup,
	deps: defaultDeps,
	openCloseDeps: defaultOpenCloseDeps,
	runDeps: (session) => runDepsFor(defaultDeps(session)),
};

function runDepsFor(deps: PhoneDeps): RunDeps {
	return { ...deps, pid: process.pid, schedule: defaultSchedule, onSignal: defaultOnSignal };
}

export function registerPhoneCommands(
	program: Command,
	makeDeps: (session?: string) => PhoneDeps = defaultDeps,
	makeOpenCloseDeps: (session?: string) => OpenCloseDeps = defaultOpenCloseDeps,
): void {
	registerPhoneGroup(program, async () => ({
		...defaultPhoneApi,
		deps: makeDeps,
		openCloseDeps: makeOpenCloseDeps,
		runDeps: (session) => runDepsFor(makeDeps(session)),
	}));
}
