import { randomBytes } from "node:crypto";
import { DgCliError } from "@dg/common";
import { readCappedStdin, resolveDgPaths, writeStdout } from "@dg/common/node";
import type { Command } from "commander";
import { nip19, SimplePool } from "nostr-tools";
import { decodeCard, encodeCard, isCardRelays, MAX_CARD_RELAYS, NO_EXPIRY, SECRET_BYTES } from "./card";
import { npubOf, type PhonePool, publish, ring, wrap } from "./chat";
import { PhoneDb } from "./db";
import { defaultKeyClients, ensureKey, type KeyDeps, ensureNumberKey } from "./keys";
import { defaultOnSignal, defaultSchedule, readListenerPid, runListener } from "./listener";
import { migrateIfNeeded } from "./migrate";
import { DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS, PHONE_SAFETY_REF, type CommandPushTarget } from "./push";
import {
	addContact,
	addInvite,
	findContactByHandle,
	findContactByNpub,
	FALLBACK_SELF_NAME,
	isHandle,
	liveInvites,
	nextFreeHandle,
	normalizeHandle,
	numberKeyId,
	readNumber,
	readRelays,
	removeContact,
	renameContact,
	requireFreeHandle,
	resolvedSelfName,
	writeNumber,
	writeRelays,
	listContacts,
} from "./store";

export type PhoneDeps = KeyDeps & {
	createPool: () => PhonePool & { close(relays: string[]): void };
	write: (text: string) => void;
	readStdin: () => Promise<string | undefined>;
	now: () => number;
};

export type RunDeps = PhoneDeps & {
	pid: number;
	schedule: Parameters<typeof runListener>[0]["schedule"];
	onSignal: Parameters<typeof runListener>[0]["onSignal"];
};

const MAX_SEND_BYTES = 64 * 1024;
const DEFAULT_INVITE_HOURS = 24;

/** The CLI entry point: migration must run before `PhoneDb.open` creates `phone.db`, since
 * `legacyRoot` stops seeing a legacy install the moment that file exists. */
function defaultDeps(session?: string): PhoneDeps {
	const paths = resolveDgPaths();
	migrateIfNeeded(paths);
	return {
		paths,
		db: PhoneDb.open(paths),
		...defaultKeyClients(paths, session),
		createPool: () => new SimplePool({ enableReconnect: true }),
		write: writeStdout,
		readStdin: () => readCappedStdin(MAX_SEND_BYTES),
		now: () => Math.floor(Date.now() / 1000),
	};
}

function printJson(deps: PhoneDeps, value: unknown): void {
	deps.write(`${JSON.stringify(value)}\n`);
}

function contactHex(npub: string): string {
	try {
		const decoded = nip19.decode(npub);
		if (decoded.type === "npub") return decoded.data;
	} catch {}
	throw new DgCliError(`contact must be an npub, got "${npub}"`);
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
	const card = encodeCard({ npub: npubOf(sk), relays, secret, exp: NO_EXPIRY, handle: as });
	printJson(deps, {
		card,
		npub: npubOf(sk),
		as,
		relays,
		expires_at: null,
		rotated,
		key_store: mode,
		listener: null,
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
	addInvite(deps.db, { secret, expiresAt, asName: selfName, name: opts.name, keyId: numberKeyId(deps.db) });
	const card = encodeCard({ npub: npubOf(sk), relays, secret, exp: expiresAt, handle: selfName });
	printJson(deps, {
		card,
		expires_at: isoOf(expiresAt),
		as: selfName,
		handle: opts.name === undefined ? null : `+${opts.name}`,
		safety: PHONE_SAFETY_REF,
	});
}

export async function phoneAccept(
	cardArg: string | undefined,
	textArg: string | undefined,
	deps: PhoneDeps,
): Promise<void> {
	migrateIfNeeded(deps.paths);
	const pasted = cardArg === undefined || cardArg === "-" ? await deps.readStdin() : cardArg;
	if (!pasted) throw new DgCliError("no call card given");
	const card = decodeCard(pasted, deps.now());
	if (card.handle === undefined) throw new DgCliError("this call card carries no handle; ask for a new card");
	const keyId = numberKeyId(deps.db);
	const sk = (await ensureKey(deps, keyId)).sk;
	const selfName = resolvedSelfName(deps.db);
	const words = textArg || "hello";
	const existing = findContactByNpub(deps.db, card.npub);
	const handle = existing?.handle ?? nextFreeHandle(deps.db, card.handle);
	if (!existing) {
		addContact(deps.db, { npub: card.npub, handle, relays: card.relays, keyId, addedAt: deps.now(), via: "accept" });
	}
	const pool = deps.createPool();
	try {
		const event = ring(words, sk, contactHex(card.npub), card.secret, selfName);
		const { ok } = await publish(pool, card.relays, event);
		if (ok.length === 0) {
			if (!existing) removeContact(deps.db, handle);
			throw new DgCliError("no relay accepted the call");
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
		printJson(deps, { handle: `+${handle}`, npub: card.npub, id: event.id, relays_ok: ok });
	} finally {
		pool.close(card.relays);
	}
}

export function phoneContacts(deps: PhoneDeps): void {
	migrateIfNeeded(deps.paths);
	for (const contact of listContacts(deps.db)) {
		printJson(deps, {
			handle: `+${contact.handle}`,
			npub: contact.npub,
			relays: contact.relays,
			key: contact.keyId,
			added_at: contact.addedAt,
			via: contact.via,
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
	const event = wrap(body, sk, contactHex(contact.npub));
	const pool = deps.createPool();
	try {
		const { ok } = await publish(pool, contact.relays, event);
		if (ok.length === 0) throw new DgCliError("no relay accepted the message");
		deps.db.addMessage({
			id: event.id,
			direction: "out",
			ts: deps.now(),
			sender: npubOf(sk),
			contact: contact.npub,
			text: body,
			call: 0,
		});
		printJson(deps, { handle: `+${handle}`, id: event.id, relays_ok: ok });
	} finally {
		pool.close(contact.relays);
	}
}

export function phoneInbox(opts: { n?: string; handle?: string }, deps: PhoneDeps): void {
	migrateIfNeeded(deps.paths);
	const limit = opts.n === undefined ? 50 : Number(opts.n);
	if (!Number.isInteger(limit) || limit <= 0) throw new DgCliError(`-n must be a positive integer, got "${opts.n}"`);
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
			text: row.text,
			read: row.read_at !== null,
			...(row.call ? { call: true } : {}),
		});
	}
}

export function phoneVoicemail(deps: PhoneDeps): void {
	migrateIfNeeded(deps.paths);
	for (const row of deps.db.takeUnread()) {
		const contact = findContactByNpub(deps.db, row.contact);
		printJson(deps, {
			id: row.id,
			ts: row.ts,
			handle: contact ? `+${contact.handle}` : null,
			from: row.sender,
			text: row.text,
			...(row.call ? { call: true } : {}),
		});
	}
}

export function phoneStatus(deps: PhoneDeps): void {
	migrateIfNeeded(deps.paths);
	const number = readNumber(deps.db);
	const listener = readListenerPid(deps.paths);
	printJson(deps, {
		as: number?.as ?? FALLBACK_SELF_NAME,
		contacts: listContacts(deps.db).length,
		pending_voicemail: deps.db.unreadMessages().length,
		listener: listener ? { pid: listener.pid, since: listener.since } : null,
		hook: listener?.hook ? { kind: "command" as const, argv: listener.hook.argv, timeout_s: listener.hook.timeoutS } : null,
	});
}

export async function phoneRun(opts: { onMessage?: string[]; onMessageTimeout?: string }, deps: RunDeps): Promise<void> {
	migrateIfNeeded(deps.paths);
	const timeoutSeconds = opts.onMessageTimeout === undefined ? DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS : Number(opts.onMessageTimeout);
	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		throw new DgCliError(`--on-message-timeout must be a positive number of seconds, got "${opts.onMessageTimeout}"`);
	}
	const hook: CommandPushTarget | undefined = opts.onMessage?.length
		? { kind: "command", argv: opts.onMessage, timeoutMs: Math.round(timeoutSeconds * 1000) }
		: undefined;
	await runListener({ ...deps, hook });
}

export function registerPhoneCommands(
	program: Command,
	makeDeps: (session?: string) => PhoneDeps = defaultDeps,
): void {
	let session: string | undefined;
	const phone = program
		.command("phone")
		.description("one phone number, many contacts: private NIP-17 chat over public Nostr relays")
		.option("--line <name>", "removed; one phone holds every contact now")
		.hook("preAction", (hooked, action) => {
			({ session } = action.optsWithGlobals<{ session?: string }>());
			if (hooked.getOptionValueSource("line") === "cli") {
				throw new DgCliError("--line is gone: one phone holds every contact; use +handle on say and inbox");
			}
		});

	phone
		.command("number")
		.description("print your number card, with your npub, relays, and listener state")
		.option("--as <name>", "self name your card carries, saved for next time")
		.option("--rotate", "roll a new secret, so every card printed before this stops admitting")
		.option("--relay <url...>", "relays your own card should use from now on")
		.action((opts: { as?: string; rotate?: boolean; relay?: string[] }) => phoneNumber(opts, makeDeps(session)));

	phone
		.command("invite")
		.description("make a one-time call card; the first ring it admits becomes a new contact")
		.option("--relay <url...>", "relays this card should use instead of the saved ones")
		.option("--ttl <hours>", "hours until the card expires", String(DEFAULT_INVITE_HOURS))
		.option("--as <name>", "self name this card carries instead of your saved one")
		.option("--name <handle>", "handle to give the contact once the call is answered")
		.action((opts: { relay?: string[]; ttl?: string; as?: string; name?: string }) => phoneInvite(opts, makeDeps(session)));

	phone
		.command("accept")
		.description("accept a call card: ring its owner and save them as a contact")
		.argument("[card]", "the call card, or - to read it from stdin", "-")
		.argument("[text]", "first words to send", "hello")
		.action((card: string, text: string) => phoneAccept(card, text, makeDeps(session)));

	const contacts = phone
		.command("contacts")
		.description("list every contact, in handle order")
		.action(() => phoneContacts(makeDeps(session)));

	contacts
		.command("rename")
		.argument("<old>", "the contact's current handle")
		.argument("<new>", "the new handle")
		.action((oldHandle: string, newHandle: string) => phoneContactsRename(oldHandle, newHandle, makeDeps(session)));

	contacts
		.command("remove")
		.argument("<handle>", "the contact to remove")
		.action((handle: string) => phoneContactsRemove(handle, makeDeps(session)));

	phone
		.command("say")
		.description("send one message to a contact")
		.argument("<handle>", "the contact's handle")
		.argument("<text>", "message text, or - to read it from stdin")
		.action((handle: string, text: string) => phoneSay(handle, text, makeDeps(session)));

	phone
		.command("inbox")
		.description("print stored messages, oldest first; never marks anything read")
		.option("-n, --count <count>", "how many messages to print", "50")
		.argument("[handle]", "limit to one contact's messages")
		.action((handle: string | undefined, opts: { count?: string }) =>
			phoneInbox({ n: opts.count, handle }, makeDeps(session)),
		);

	phone
		.command("voicemail")
		.description("print unread messages, oldest first, and mark them read")
		.action(() => phoneVoicemail(makeDeps(session)));

	phone
		.command("status")
		.description("print your self name, contact count, and pending voicemail count")
		.action(() => phoneStatus(makeDeps(session)));

	phone
		.command("__run", { hidden: true })
		.description("internal: run the always-on listener in the foreground (never call directly)")
		.option("--on-message <argv...>", "command and args to run for each delivered message")
		.option("--on-message-timeout <seconds>", "seconds before --on-message is killed", String(DEFAULT_ON_MESSAGE_TIMEOUT_SECONDS))
		.action((opts: { onMessage?: string[]; onMessageTimeout?: string }) =>
			phoneRun(opts, { ...makeDeps(session), pid: process.pid, schedule: defaultSchedule, onSignal: defaultOnSignal }),
		);
}
