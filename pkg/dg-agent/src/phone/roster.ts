import { createHash } from "node:crypto";
import { DgCliError, isRecord } from "@dg/common";
import { getPublicKey, nip19 } from "nostr-tools";
import {
	FILE_REQUEST_KIND,
	type ControlRumor,
	type PhonePool,
	PRESENCE_KIND,
	RECEIPT_KIND,
	ROSTER_KIND,
	publish,
	shouldSaveOutgoing,
	wrapTagged,
} from "./chat";
import type { PhoneDb } from "./db";
import { PUBLISH_CONFIRM_ENV, resolvePublishConfirmMs } from "./delivery";
import { type KeyDeps, ensureKey, loadKey } from "./keys";
import {
	type AgentRuntime,
	type DiscoveredAgent,
	currentSelfName,
	discoverAgents,
	namesForRoster,
	type NameSeams,
} from "./names";
import {
	FALLBACK_SELF_NAME,
	bumpAdmissionEpoch,
	contactRelays,
	findContactByHandle,
	findContactByNpub,
	insertNewContact,
	isHandle,
	listContacts,
	normalizeHandle,
	pubkeyHex,
	readPublishConfirmSetting,
} from "./store";

export const ROSTER_VERSION = 1;
export const ROSTER_TAG = "dg-roster";
export const ROSTER_BODY_TAG = "dg-agents";
export const ROSTER_LIMIT = 16;
export const ROSTER_HARD_CAP = 64;
export const ROSTER_DEBOUNCE_S = 2;
export const ROSTER_DEBOUNCE_MAX_S = 30;
export const ROSTER_FANOUT = 16;
export const ROSTER_PUSH_SETTING = "roster_push";

/** Kinds a dg-agent that predates rosters already understood. A roster kind must not be one of them. */
export const LEGACY_CHAT_KINDS = [14, 15] as const;
export const LEGACY_CONTROL_KINDS = [FILE_REQUEST_KIND, RECEIPT_KIND, PRESENCE_KIND] as const;

export type RosterIntent = "offer" | "reply" | "update";

export type RosterAgent = { handle: string; npub: string; runtime?: AgentRuntime };

export type PushState = { dirty: boolean; notBefore: number; hash: string; since: number; cursor: number };

export type RosterDeps = KeyDeps & {
	createPool: () => PhonePool & { close(relays: string[]): void };
	now: () => number;
	env?: Record<string, string | undefined>;
	homeDir?: string;
	sessionId?: string;
	writeErr?: (text: string) => void;
};

const RUNTIMES = new Set<AgentRuntime>(["claude", "codex", "grok", "dg"]);

/** What an older peer does with a rumor kind. Roster kinds are ignored; chat still flows. */
export function legacyPeerDisposition(kind: number): "chat" | "control" | "ignore" {
	if ((LEGACY_CHAT_KINDS as readonly number[]).includes(kind)) return "chat";
	if ((LEGACY_CONTROL_KINDS as readonly number[]).includes(kind)) return "control";
	return "ignore";
}

export function isNpub(value: string): boolean {
	try {
		const decoded = nip19.decode(value);
		return decoded.type === "npub" && /^[0-9a-f]{64}$/.test(decoded.data);
	} catch {
		return false;
	}
}

function runtimeOf(value: unknown): AgentRuntime | undefined {
	return typeof value === "string" && RUNTIMES.has(value as AgentRuntime) ? (value as AgentRuntime) : undefined;
}

export function canonicalAgents(agents: readonly RosterAgent[]): RosterAgent[] {
	return [...agents]
		.map((agent) => (agent.runtime ? { handle: agent.handle, npub: agent.npub, runtime: agent.runtime } : { handle: agent.handle, npub: agent.npub }))
		.sort((left, right) => left.handle.localeCompare(right.handle) || left.npub.localeCompare(right.npub));
}

export function rosterHash(agents: readonly RosterAgent[]): string {
	const lines = canonicalAgents(agents).map((agent) => `${agent.handle}\t${agent.npub}\t${agent.runtime ?? ""}`);
	return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function parseAgent(entry: unknown): RosterAgent | undefined {
	if (!isRecord(entry)) return undefined;
	if (typeof entry.handle !== "string" || !isHandle(entry.handle)) return undefined;
	if (typeof entry.npub !== "string" || !isNpub(entry.npub)) return undefined;
	const runtime = runtimeOf(entry.runtime);
	return runtime ? { handle: entry.handle, npub: entry.npub, runtime } : { handle: entry.handle, npub: entry.npub };
}

/** Versioned roster document. `undefined` means the whole document is refused. */
export function parseRosterBody(raw: string): RosterAgent[] | undefined {
	if (raw.length > 8192) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.v !== ROSTER_VERSION || !Array.isArray(value.agents)) return undefined;
	if (value.agents.length > ROSTER_HARD_CAP) return undefined;
	const out: RosterAgent[] = [];
	const handles = new Set<string>();
	const npubs = new Set<string>();
	for (const entry of value.agents) {
		if (out.length >= ROSTER_LIMIT) break;
		const agent = parseAgent(entry);
		if (!agent || handles.has(agent.handle) || npubs.has(agent.npub)) continue;
		handles.add(agent.handle);
		npubs.add(agent.npub);
		out.push(agent);
	}
	return out;
}

export function rosterDocument(agents: readonly RosterAgent[]): string {
	return JSON.stringify({ v: ROSTER_VERSION, agents: canonicalAgents(agents) });
}

export function rosterFromControl(control: { kind: number; tags: string[][] }): { intent: RosterIntent; agents: RosterAgent[] } | undefined {
	if (control.kind !== ROSTER_KIND) return undefined;
	const intent = control.tags.find((tag) => tag[0] === ROSTER_TAG)?.[1];
	if (intent !== "offer" && intent !== "reply" && intent !== "update") return undefined;
	const body = control.tags.find((tag) => tag[0] === ROSTER_BODY_TAG)?.[1];
	if (body === undefined) return undefined;
	const agents = parseRosterBody(body);
	if (!agents) return undefined;
	return { intent, agents };
}

export type ApplyResult =
	| { ok: false; reason: "stranger" | "imported" }
	| { ok: true; added: string[]; skipped: string[]; removed: string[] };

/**
 * Stores the far machine's agents as contacts tagged with that machine.
 * The signer must be a contact we paired directly. A contact that arrived `via: "roster"`
 * cannot admit more contacts. A handle or npub we already keep for someone else is skipped.
 * The writes commit together.
 */
export function applyRoster(
	db: PhoneDb,
	senderNpub: string,
	agents: readonly RosterAgent[],
	now: number,
	ownNpubs: ReadonlySet<string>,
): ApplyResult {
	const sender = findContactByNpub(db, senderNpub);
	if (!sender) return { ok: false, reason: "stranger" };
	if (sender.via === "roster") return { ok: false, reason: "imported" };
	return db.transaction(() => applyRosterBody(db, senderNpub, sender.relays, sender.keyId, agents, now, ownNpubs));
}

function applyRosterBody(
	db: PhoneDb,
	senderNpub: string,
	senderRelays: string[],
	senderKeyId: string,
	agents: readonly RosterAgent[],
	now: number,
	ownNpubs: ReadonlySet<string>,
): ApplyResult {
	const added: string[] = [];
	const skipped: string[] = [];
	const wanted = new Set<string>();
	for (const agent of agents) {
		if (agent.npub === senderNpub || ownNpubs.has(agent.npub)) {
			skipped.push(agent.handle);
			continue;
		}
		wanted.add(agent.npub);
		const byNpub = findContactByNpub(db, agent.npub);
		const byHandle = findContactByHandle(db, agent.handle);
		if (byHandle && byHandle.npub !== agent.npub) {
			skipped.push(agent.handle);
			continue;
		}
		if (byNpub) {
			if (byNpub.originNpub !== senderNpub) {
				skipped.push(agent.handle);
				continue;
			}
			if (byNpub.handle !== agent.handle && !byHandle) {
				db.putContact({
					npub: byNpub.npub,
					handle: agent.handle,
					relays: JSON.stringify(byNpub.relays),
					key_id: byNpub.keyId,
					added_at: byNpub.addedAt,
					via: byNpub.via,
					origin_npub: senderNpub,
					runtime: agent.runtime ?? byNpub.runtime ?? null,
				});
			}
			continue;
		}
		const inserted = insertNewContact(db, {
			npub: agent.npub,
			handle: agent.handle,
			relays: senderRelays,
			keyId: senderKeyId,
			addedAt: now,
			via: "roster",
			originNpub: senderNpub,
			...(agent.runtime ? { runtime: agent.runtime } : {}),
		});
		if (inserted) added.push(agent.handle);
		else skipped.push(agent.handle);
	}
	const removed: string[] = [];
	for (const contact of listContacts(db)) {
		if (contact.originNpub !== senderNpub || wanted.has(contact.npub)) continue;
		db.removeContact(contact.npub);
		removed.push(contact.handle);
	}
	if (added.length > 0 || removed.length > 0) bumpAdmissionEpoch(db);
	return { ok: true, added, skipped, removed };
}

/** Drops every contact that arrived in that machine's roster. The machine contact itself stays. */
export function clearMachineContacts(db: PhoneDb, handleArg: string): { machine: string; removed: string[] } {
	const handle = normalizeHandle(handleArg);
	const named = findContactByHandle(db, handle);
	if (!named) throw new DgCliError(`no contact +${handle}`);
	const machineNpub = named.originNpub ?? named.npub;
	const removed: string[] = [];
	for (const contact of listContacts(db)) {
		if (contact.originNpub !== machineNpub) continue;
		db.removeContact(contact.npub);
		removed.push(contact.handle);
	}
	db.clearRosterSent(machineNpub);
	db.takeHeldRoster(machineNpub);
	if (removed.length > 0) bumpAdmissionEpoch(db);
	const machine = findContactByNpub(db, machineNpub);
	return { machine: `+${machine?.handle ?? handle}`, removed: removed.map((item) => `+${item}`) };
}

export function planRosterFlush(input: {
	now: number;
	hash: string;
	agentCount: number;
	peers: readonly string[];
	sent: ReadonlyMap<string, string>;
	state: PushState | undefined;
}): { state: PushState; send: string[] } {
	const idle = (hash: string): PushState => ({ dirty: false, notBefore: 0, hash, since: input.now, cursor: 0 });
	if (input.agentCount === 0 && input.sent.size === 0) return { state: idle(input.hash), send: [] };
	const needing = input.peers.filter((npub) => input.sent.get(npub) !== input.hash);
	if (needing.length === 0) return { state: idle(input.hash), send: [] };
	const base = input.state ?? { dirty: false, notBefore: 0, hash: "", since: input.now, cursor: 0 };
	let waiting: PushState;
	if (!base.dirty || base.hash !== input.hash) {
		const since = base.dirty ? base.since : input.now;
		waiting = {
			dirty: true,
			notBefore: Math.min(input.now + ROSTER_DEBOUNCE_S, since + ROSTER_DEBOUNCE_MAX_S),
			hash: input.hash,
			since,
			cursor: 0,
		};
	} else {
		waiting = { ...base, hash: input.hash };
	}
	if (input.now < waiting.notBefore) return { state: waiting, send: [] };
	const ordered = [...input.peers].sort();
	const send: string[] = [];
	let cursor = waiting.cursor;
	for (let step = 0; step < ordered.length && send.length < ROSTER_FANOUT; step += 1) {
		const npub = ordered[cursor % ordered.length];
		cursor += 1;
		if (npub !== undefined && input.sent.get(npub) !== input.hash) send.push(npub);
	}
	const more = ordered.some((npub) => input.sent.get(npub) !== input.hash && !send.includes(npub));
	return {
		state: {
			dirty: more,
			notBefore: more ? input.now : waiting.notBefore,
			hash: input.hash,
			since: waiting.since,
			cursor: cursor % ordered.length,
		},
		send,
	};
}

export function setupSelfName(explicit: string | undefined, saved: string | undefined, agents: readonly DiscoveredAgent[]): string {
	if (explicit !== undefined) return explicit;
	if (saved !== undefined) return saved;
	return currentSelfName(agents) ?? FALLBACK_SELF_NAME;
}

function seamsFor(deps: RosterDeps): NameSeams {
	return {
		env: deps.env ?? {},
		homeDir: deps.homeDir,
		sessionsDir: deps.paths.sessionsDir,
		daemonDb: deps.paths.dbPath,
		sessionId: deps.sessionId,
	};
}

export function discoveredAgents(deps: RosterDeps): DiscoveredAgent[] {
	return discoverAgents(seamsFor(deps));
}

async function ownNpubs(deps: RosterDeps): Promise<Set<string>> {
	const own = new Set<string>();
	for (const id of deps.db.listKeyIds()) {
		try {
			const loaded = await loadKey(deps, id);
			if (loaded) own.add(nip19.npubEncode(getPublicKey(loaded.sk)));
		} catch {
			// An unreadable key is skipped. It is not treated as a peer.
		}
	}
	return own;
}

export async function syncIdentities(deps: RosterDeps): Promise<void> {
	const found = namesForRoster(discoveredAgents(deps), ROSTER_LIMIT);
	const have = new Set(deps.db.listIdentities().map((row) => row.handle));
	for (const agent of found) {
		if (have.has(agent.handle)) continue;
		if (deps.db.listIdentities().length >= ROSTER_LIMIT) break;
		const keyId = `agent-${agent.handle}`;
		await ensureKey(deps, keyId);
		deps.db.putIdentity(agent.handle, keyId, agent.runtime);
		have.add(agent.handle);
	}
}

export async function localRoster(deps: RosterDeps): Promise<RosterAgent[]> {
	const agents: RosterAgent[] = [];
	for (const row of deps.db.listIdentities()) {
		if (!isHandle(row.handle)) continue;
		const loaded = await loadKey(deps, row.key_id);
		if (!loaded) continue;
		const runtime = runtimeOf(row.runtime);
		agents.push({
			handle: row.handle,
			npub: nip19.npubEncode(getPublicKey(loaded.sk)),
			...(runtime ? { runtime } : {}),
		});
	}
	return canonicalAgents(agents).slice(0, ROSTER_LIMIT);
}

function confirmMs(deps: RosterDeps): number {
	return resolvePublishConfirmMs(deps.env?.[PUBLISH_CONFIRM_ENV], readPublishConfirmSetting(deps.db));
}

export async function sendRoster(
	deps: RosterDeps,
	npub: string,
	intent: RosterIntent,
	opts: { force?: boolean; agents?: RosterAgent[]; hash?: string } = {},
): Promise<boolean> {
	const contact = findContactByNpub(deps.db, npub);
	if (!contact) return false;
	const agents = opts.agents ?? (await localRoster(deps));
	const hash = opts.hash ?? rosterHash(agents);
	if (!opts.force && deps.db.readRosterSent(npub) === hash) return false;
	const loaded = await loadKey(deps, contact.keyId);
	if (!loaded) return false;
	const relays = contactRelays(deps.db, npub);
	if (relays.length === 0) return false;
	const event = wrapTagged(
		{ kind: ROSTER_KIND, content: "", tags: [[ROSTER_TAG, intent], [ROSTER_BODY_TAG, rosterDocument(agents)]] },
		loaded.sk,
		pubkeyHex(npub),
	);
	const pool = deps.createPool();
	try {
		const report = await publish(pool, relays, event, { confirmMs: confirmMs(deps) });
		if (!shouldSaveOutgoing(report)) return false;
		deps.db.writeRosterSent(npub, hash);
		return true;
	} catch {
		deps.writeErr?.("phone: roster was not sent\n");
		return false;
	} finally {
		pool.close(relays);
	}
}

function npubFromHex(hex: string): string | undefined {
	if (!/^[0-9a-f]{64}$/.test(hex)) return undefined;
	try {
		return nip19.npubEncode(hex);
	} catch {
		return undefined;
	}
}

/** Applies one roster rumor. An offer from a contact gets one reply. A stranger is held, not stored. */
export async function handleIncomingRoster(deps: RosterDeps, control: ControlRumor): Promise<void> {
	const parsed = rosterFromControl(control);
	if (!parsed) return;
	const sender = npubFromHex(control.from);
	if (!sender) return;
	const own = await ownNpubs(deps);
	if (own.has(sender)) return;
	const result = applyRoster(deps.db, sender, parsed.agents, deps.now(), own);
	if (!result.ok) {
		if (result.reason === "stranger") deps.db.holdRoster(sender, rosterDocument(parsed.agents), parsed.intent);
		return;
	}
	if (parsed.intent === "offer") await sendRoster(deps, sender, "reply", { force: true });
}

// Stryker disable all
/** After a new contact lands: apply a roster that arrived first, and offer ours when they did not. */
export async function announceRoster(deps: RosterDeps, npub: string): Promise<void> {
	const held = deps.db.takeHeldRoster(npub);
	if (held) {
		const agents = parseRosterBody(held.body);
		if (agents) {
			const own = await ownNpubs(deps);
			const applied = applyRoster(deps.db, npub, agents, deps.now(), own);
			if (applied.ok && held.intent === "offer") {
				await sendRoster(deps, npub, "reply", { force: true });
				return;
			}
		}
	}
	await sendRoster(deps, npub, "offer", { force: true });
}

export async function settleCaughtRosters(deps: RosterDeps, controls: readonly ControlRumor[], newContacts: readonly string[]): Promise<void> {
	const answered = new Set<string>();
	for (const control of controls) {
		if (control.kind !== ROSTER_KIND) continue;
		await handleIncomingRoster(deps, control);
		const sender = npubFromHex(control.from);
		if (sender) answered.add(sender);
	}
	for (const npub of newContacts) {
		if (!answered.has(npub)) await announceRoster(deps, npub);
	}
}

// Stryker restore all
export async function flushRosterPush(deps: RosterDeps): Promise<number> {
	await syncIdentities(deps);
	const agents = await localRoster(deps);
	const hash = rosterHash(agents);
	const machines = listContacts(deps.db).filter((contact) => contact.via !== "roster");
	const sent = new Map<string, string>();
	for (const contact of machines) {
		const value = deps.db.readRosterSent(contact.npub);
		if (value !== undefined) sent.set(contact.npub, value);
	}
	const saved = deps.db.get<PushState>(ROSTER_PUSH_SETTING);
	const plan = planRosterFlush({
		now: deps.now(),
		hash,
		agentCount: agents.length,
		peers: machines.map((contact) => contact.npub),
		sent,
		state: saved,
	});
	deps.db.set(ROSTER_PUSH_SETTING, plan.state);
	let delivered = 0;
	for (const npub of plan.send) {
		if (await sendRoster(deps, npub, "update", { agents, hash })) delivered += 1;
	}
	return delivered;
}

