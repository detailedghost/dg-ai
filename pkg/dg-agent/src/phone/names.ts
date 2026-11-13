import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readSessionFiles, readSessionIdentities, selectSoleSession } from "@dg/common/node";
import { isHandle } from "./store";

/** Which runtime a local name was read from. The roster carries this label and does not trust it. */
export type AgentRuntime = "claude" | "codex" | "grok" | "dg";

export type DiscoveredAgent = {
	runtime: AgentRuntime;
	/** The name as the runtime stored it, before it became a handle. */
	name: string;
	handle: string;
	/** This process is that agent. Other rows on the machine are roster-only. */
	current: boolean;
	/** Unix seconds of the last activity the runtime recorded. Absent means it did not say. */
	activeAt?: number;
};

export type NameSeams = {
	env: Record<string, string | undefined>;
	homeDir?: string;
	sessionsDir?: string;
	daemonDb?: string;
	sessionId?: string;
};

const FILE_CAP = 200;
const FILE_BYTES = 65_536;
const INDEX_BYTES = 1_048_576;
const INDEX_LINES = 500;
const WALK_DEPTH = 4;
/** Daemon default and the unnamed card self name are not names anyone chose. */
const UNNAMED = new Set(["agent", "default"]);
/**
 * A session quiet for longer than this is left off the roster. The process that is
 * running (the current session id) is kept anyway. 24 hours matches a working day
 * of agents, not the 30-day import window Codex uses when it copies old transcripts.
 */
export const ROSTER_ACTIVE_WINDOW_S = 24 * 60 * 60;
/** A stored label with more words than this is prompt prose, not a title. Rename-session uses 3 to 6. */
export const TITLE_MAX_WORDS = 6;
/** A label this long that is only the start of the prompt is an excerpt, not a title. */
const PROMPT_SLICE_MIN = 8;
const FALLBACK_ID_MIN = 4;
const FALLBACK_ID_CHARS = 12;

function trimmed(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text === "" ? undefined : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A session name as a phone handle. Spaces and mixed case collapse; a placeholder does not. */
export function slugHandle(name: string | undefined): string | undefined {
	const text = trimmed(name)?.toLowerCase();
	if (text === undefined || UNNAMED.has(text)) return undefined;
	const slugged = text
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return isHandle(slugged) ? slugged : undefined;
}

/** True when slugging `name` would chop characters off, the way a long prompt becomes a 32-character slice. */
export function slugDropsText(name: string, handle: string): boolean {
	const full = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return full !== handle;
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter((word) => word !== "").length;
}

/** One lowercase word, the way Codex stores the first word of a prompt (`continue`) as `thread_name`. */
function isBarePromptWord(text: string): boolean {
	return /^[a-z][a-z0-9]*$/.test(text);
}

/** `text` is the leading slice of `prompt`, not a separate title. */
function isPromptSlice(text: string, prompt: string): boolean {
	return text.length < prompt.length && text.length >= PROMPT_SLICE_MIN && prompt.startsWith(text);
}

function usableTitle(value: string | undefined, prompt: string | undefined, bareWordIsPrompt: boolean): string | undefined {
	const text = trimmed(value);
	if (text === undefined) return undefined;
	if (prompt !== undefined && text === prompt) return undefined;
	if (prompt !== undefined && isPromptSlice(text, prompt)) return undefined;
	if (bareWordIsPrompt && isBarePromptWord(text)) return undefined;
	if (wordCount(text) > TITLE_MAX_WORDS) return undefined;
	const handle = slugHandle(text);
	if (handle === undefined) return undefined;
	if (slugDropsText(text, handle)) return undefined;
	return text;
}

/**
 * A stable handle when the runtime has no title. `codex-` plus the first 12
 * letters and digits of the thread id, longer only when that handle is taken.
 */
export function fallbackHandle(runtime: AgentRuntime, id: string | undefined, used: ReadonlySet<string>): string | undefined {
	const compact = trimmed(id)?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
	if (compact.length < FALLBACK_ID_MIN) return undefined;
	const start = Math.min(FALLBACK_ID_CHARS, compact.length);
	for (let length = start; length <= compact.length; length += 1) {
		const handle = `${runtime}-${compact.slice(0, length)}`;
		if (handle.length > 32) return undefined;
		if (isHandle(handle) && !used.has(handle)) return handle;
	}
	return undefined;
}

export type SessionNameInput = {
	runtime: AgentRuntime;
	id?: string;
	/** Explicit titles. The first one that is not the prompt wins. */
	titles?: readonly (string | undefined)[];
	/** `thread_name` or a session `name`, which may be the prompt itself. */
	label?: string;
	/** Prompt, preview, or first user message. Never slugged. */
	prompt?: string;
	/**
	 * Codex writes the first word of the prompt into `thread_name` with no capital.
	 * A one-word lowercase label is that prompt, not a title someone chose.
	 */
	bareWordIsPrompt?: boolean;
};

function isPlaceholder(value: string | undefined): boolean {
	const text = trimmed(value)?.toLowerCase();
	return text !== undefined && UNNAMED.has(text);
}

/** Display name for one session: a real title, a short summary, or `runtime-<id>`. A missing name stays missing. */
export function chooseSessionName(input: SessionNameInput): string | undefined {
	const prompt = trimmed(input.prompt);
	let rejectedPrompt = false;
	for (const candidate of input.titles ?? []) {
		if (trimmed(candidate) === undefined) continue;
		const title = usableTitle(candidate, prompt, false);
		if (title !== undefined) return title;
		if (!isPlaceholder(candidate)) rejectedPrompt = true;
	}
	if (trimmed(input.label) !== undefined) {
		const label = usableTitle(input.label, prompt, input.bareWordIsPrompt === true);
		if (label !== undefined) return label;
		if (!isPlaceholder(input.label)) rejectedPrompt = true;
	}
	if (!rejectedPrompt) return undefined;
	return fallbackHandle(input.runtime, input.id, new Set());
}

/** Unix seconds from an ISO time or a seconds-or-milliseconds number. Absent when the value is not a time. */
export function activitySeconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		if (value <= 0) return undefined;
		const seconds = value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
		return seconds > 0 ? seconds : undefined;
	}
	if (typeof value === "string") {
		const text = trimmed(value);
		if (text === undefined) return undefined;
		const parsed = Date.parse(text);
		if (Number.isNaN(parsed)) return undefined;
		const seconds = Math.floor(parsed / 1000);
		return seconds > 0 ? seconds : undefined;
	}
	return undefined;
}

export function latestTime(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return left > right ? left : right;
}

/**
 * The running session is always on the roster. Everyone else needs activity inside the
 * window, or no timestamp at all (the runtime did not record one).
 */
export function rosterEligible(agent: DiscoveredAgent, now: number): boolean {
	if (agent.current) return true;
	if (agent.activeAt === undefined) return true;
	return now - agent.activeAt <= ROSTER_ACTIVE_WINDOW_S;
}

/** `next` replaces `prev` when it was active later, or it is the later row and neither time wins. */
export function preferNewer(next: { activeAt?: number; index: number }, prev: { activeAt?: number; index: number }): boolean {
	if (typeof next.activeAt === "number" && typeof prev.activeAt === "number") {
		if (next.activeAt > prev.activeAt) return true;
		if (next.activeAt < prev.activeAt) return false;
	} else if (typeof next.activeAt === "number" && prev.activeAt === undefined) return true;
	else if (next.activeAt === undefined && typeof prev.activeAt === "number") return false;
	return next.index > prev.index;
}

/** The running agent's handle. A Claude, Codex, or Grok name wins over a dg session; none means unset. */
export function currentSelfName(agents: readonly DiscoveredAgent[]): string | undefined {
	const order: readonly AgentRuntime[] = ["claude", "codex", "grok", "dg"];
	for (const runtime of order) {
		const hit = agents.find((agent) => agent.current && agent.runtime === runtime);
		if (hit) return hit.handle;
	}
	return undefined;
}

/**
 * Live and recent agents, current first, then most recently active, then handle.
 * One row per handle. A tie on activity keeps the earlier handle so the cap is stable.
 */
export function namesForRoster(agents: readonly DiscoveredAgent[], limit: number, now = Math.floor(Date.now() / 1000)): DiscoveredAgent[] {
	if (limit <= 0) return [];
	const ranked = agents.filter((agent) => rosterEligible(agent, now)).sort((left, right) => {
		if (left.current !== right.current) return left.current ? -1 : 1;
		const leftAt = left.activeAt ?? Number.NEGATIVE_INFINITY;
		const rightAt = right.activeAt ?? Number.NEGATIVE_INFINITY;
		if (leftAt !== rightAt) return rightAt - leftAt;
		return left.handle.localeCompare(right.handle) || left.runtime.localeCompare(right.runtime);
	});
	const seen = new Set<string>();
	const out: DiscoveredAgent[] = [];
	for (const agent of ranked) {
		if (seen.has(agent.handle)) continue;
		seen.add(agent.handle);
		if (out.length >= limit) break;
		out.push(agent);
	}
	return out;
}

/** Non-empty lines, keeping the last `maxLines` so an append-only index shows its newest rows. */
export function tailLines(text: string, maxLines: number): string[] {
	if (maxLines <= 0) return [];
	const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
	if (lines.length <= maxLines) return lines;
	return lines.slice(lines.length - maxLines);
}

// Stryker disable all
function readCapped(path: string, maxBytes: number): string | undefined {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return undefined;
	}
	if (!stat.isFile() || stat.size > maxBytes) return undefined;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function mtimeSeconds(path: string): number | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile()) return undefined;
		const seconds = Math.floor(stat.mtimeMs / 1000);
		return seconds > 0 ? seconds : undefined;
	} catch {
		return undefined;
	}
}

function walkJson(dir: string, left: number, depth: number): string[] {
	if (left <= 0 || depth > WALK_DEPTH) return [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const name of names) {
		if (out.length >= left) break;
		const path = join(dir, name);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(path);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) {
			out.push(...walkJson(path, left - out.length, depth + 1));
			continue;
		}
		if (stat.isFile() && name.endsWith(".json") && stat.size <= FILE_BYTES) out.push(path);
	}
	return out;
}

// Stryker restore all
function parseRecord(text: string): Record<string, unknown> | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	return isRecord(value) ? value : undefined;
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = trimmed(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

function recordActivity(record: Record<string, unknown>): number | undefined {
	return latestTime(
		activitySeconds(record.updatedAt),
		latestTime(activitySeconds(record.updated_at), activitySeconds(record.lastActivity)),
	);
}

function claudeDisplayName(record: Record<string, unknown>, sessionId: string | undefined): string | undefined {
	const id = firstString(record, ["id", "sessionId", "session_id"]) ?? trimmed(sessionId);
	return chooseSessionName({
		runtime: "claude",
		id,
		titles: [firstString(record, ["customTitle", "custom_title"]), firstString(record, ["summary", "aiTitle", "ai_title"])],
		label: trimmed(record.name),
		prompt: firstString(record, ["prompt", "firstPrompt", "first_prompt", "preview"]),
	});
}

/** `{name}` from a Claude session file. `current` when the file is the session id this process is. */
export function claudeNameFromJson(text: string, sessionId: string | undefined): { name: string; current: boolean } | undefined {
	const record = parseRecord(text);
	if (!record) return undefined;
	const name = claudeDisplayName(record, sessionId);
	if (name === undefined) return undefined;
	const id = trimmed(sessionId);
	const marked = id !== undefined && [record.id, record.sessionId, record.session_id].some((field) => trimmed(field) === id);
	return { name, current: marked };
}

type CodexRow = { name: string; current: boolean; id?: string; activeAt?: number; index: number };

/** One `session_index.jsonl` line. A real title wins; a prompt excerpt becomes `codex-<id>`. */
export function codexNameFromLine(line: string, threadId: string | undefined): { name: string; current: boolean } | undefined {
	const row = codexRowFromLine(line, threadId, 0);
	if (!row) return undefined;
	return { name: row.name, current: row.current };
}

function codexRowFromLine(line: string, threadId: string | undefined, index: number): CodexRow | undefined {
	const record = parseRecord(line);
	if (!record) return undefined;
	const id = firstString(record, ["id", "thread_id"]);
	const current = threadId !== undefined && threadId !== "" && id === threadId;
	const name = chooseSessionName({
		runtime: "codex",
		id,
		titles: [
			firstString(record, ["custom_title", "customTitle"]),
			firstString(record, ["title"]),
			firstString(record, ["summary", "ai_title", "aiTitle"]),
		],
		label: firstString(record, ["thread_name", "name"]),
		prompt: firstString(record, ["preview", "first_user_message", "firstUserMessage", "prompt"]),
		bareWordIsPrompt: true,
	});
	if (name === undefined) return undefined;
	const activeAt = latestTime(activitySeconds(record.updated_at), activitySeconds(record.updatedAt));
	return { name, current, index, ...(id !== undefined ? { id } : {}), ...(activeAt !== undefined ? { activeAt } : {}) };
}

function collapseCodex(rows: readonly CodexRow[]): CodexRow[] {
	const best = new Map<string, CodexRow>();
	const order: string[] = [];
	for (const row of rows) {
		const key = row.id !== undefined && row.id !== "" ? row.id : `\0${row.index}`;
		const prev = best.get(key);
		if (!prev) {
			order.push(key);
			best.set(key, row);
			continue;
		}
		if (preferNewer(row, prev)) best.set(key, row);
	}
	return order.flatMap((key) => {
		const row = best.get(key);
		return row === undefined ? [] : [row];
	});
}

function claimHandle(
	runtime: AgentRuntime,
	name: string,
	id: string | undefined,
	used: ReadonlySet<string>,
): { name: string; handle: string } | undefined {
	if (isPlaceholder(name)) return undefined;
	const preferred = slugHandle(name);
	if (preferred !== undefined && !used.has(preferred) && !slugDropsText(name, preferred)) return { name, handle: preferred };
	const fallback = fallbackHandle(runtime, id, used);
	if (fallback === undefined) return undefined;
	return { name: fallback, handle: fallback };
}

function pushClaimed(
	out: DiscoveredAgent[],
	runtime: AgentRuntime,
	name: string,
	current: boolean,
	activeAt: number | undefined,
	id: string | undefined,
	used: Set<string>,
): void {
	const claimed = claimHandle(runtime, name, id, used);
	if (!claimed) return;
	used.add(claimed.handle);
	out.push({
		runtime,
		name: claimed.name,
		handle: claimed.handle,
		current,
		...(activeAt !== undefined ? { activeAt } : {}),
	});
}

function claudeAgents(seams: NameSeams, out: DiscoveredAgent[], used: Set<string>): void {
	const home = seams.homeDir;
	if (home === undefined) return;
	const config = seams.env.CLAUDE_CONFIG_DIR;
	const root = config && isAbsolute(config) ? config : join(home, ".claude");
	const sessionId = trimmed(seams.env.CLAUDE_CODE_SESSION_ID) ?? trimmed(seams.env.CLAUDE_SESSION_ID);
	for (const path of walkJson(join(root, "sessions"), FILE_CAP, 0)) {
		const text = readCapped(path, FILE_BYTES);
		if (text === undefined) continue;
		const record = parseRecord(text);
		if (!record) continue;
		const name = claudeDisplayName(record, sessionId);
		if (name === undefined) continue;
		const id = firstString(record, ["id", "sessionId", "session_id"]);
		const current = sessionId !== undefined && [record.id, record.sessionId, record.session_id].some((field) => trimmed(field) === sessionId);
		pushClaimed(out, "claude", name, current, latestTime(recordActivity(record), mtimeSeconds(path)), id, used);
	}
}

function codexAgents(seams: NameSeams, out: DiscoveredAgent[], used: Set<string>): void {
	const home = seams.homeDir;
	if (home === undefined) return;
	const configured = seams.env.CODEX_HOME;
	const root = configured && isAbsolute(configured) ? configured : join(home, ".codex");
	const text = readCapped(join(root, "session_index.jsonl"), INDEX_BYTES);
	if (text === undefined) return;
	const threadId = trimmed(seams.env.CODEX_THREAD_ID);
	const rows: CodexRow[] = [];
	for (const line of tailLines(text, INDEX_LINES)) {
		const parsed = codexRowFromLine(line, threadId, rows.length);
		if (parsed) rows.push(parsed);
	}
	for (const row of collapseCodex(rows)) {
		pushClaimed(out, "codex", row.name, row.current, row.activeAt, row.id, used);
	}
}

function grokAgents(seams: NameSeams, out: DiscoveredAgent[], used: Set<string>): void {
	const agent = trimmed(seams.env.GROK_AGENT_NAME);
	const bot = trimmed(seams.env.GROK_BOT_NAME);
	if (agent !== undefined) {
		const name = chooseSessionName({ runtime: "grok", label: agent });
		if (name !== undefined) pushClaimed(out, "grok", name, true, undefined, undefined, used);
	}
	if (bot !== undefined && bot !== agent) {
		const name = chooseSessionName({ runtime: "grok", label: bot });
		if (name !== undefined) pushClaimed(out, "grok", name, agent === undefined, undefined, undefined, used);
	}
	const home = seams.homeDir;
	if (home === undefined) return;
	const configured = seams.env.GROK_HOME;
	const root = configured && isAbsolute(configured) ? configured : join(home, ".grok");
	for (const path of walkJson(join(root, "agents"), FILE_CAP, 0)) {
		const text = readCapped(path, FILE_BYTES);
		if (text === undefined) continue;
		const record = parseRecord(text);
		if (!record) continue;
		const stored = trimmed(record.name);
		if (stored === undefined || stored === agent || stored === bot) continue;
		const id = firstString(record, ["id"]) ?? fileStem(path);
		const name = chooseSessionName({
			runtime: "grok",
			id,
			titles: [firstString(record, ["title"]), firstString(record, ["summary"])],
			label: stored,
			prompt: firstString(record, ["prompt", "preview"]),
		});
		if (name === undefined) continue;
		pushClaimed(out, "grok", name, false, latestTime(recordActivity(record), mtimeSeconds(path)), id, used);
	}
}

function fileStem(path: string): string | undefined {
	const base = path.split(/[/\\]/).pop();
	const stem = base?.replace(/\.json$/i, "");
	return trimmed(stem);
}

function dgAgents(seams: NameSeams, out: DiscoveredAgent[], used: Set<string>): void {
	const files = seams.sessionsDir === undefined ? [] : readSessionFiles(seams.sessionsDir);
	const fromDb =
		seams.daemonDb === undefined
			? []
			: readSessionIdentities(seams.daemonDb).filter((row) => !files.some((file) => file.sessionId === row.sessionId));
	let sessionId = trimmed(seams.sessionId);
	// Stryker disable all
	if (sessionId === undefined && files.length > 0) {
		try {
			sessionId = selectSoleSession(files).sessionId;
		} catch {
			sessionId = undefined;
		}
	}
	// Stryker restore all
	for (const record of [...files, ...fromDb]) {
		const handle = slugHandle(record.agentIdentity);
		if (handle === undefined || used.has(handle)) continue;
		used.add(handle);
		const activeAt = seams.sessionsDir === undefined ? undefined : mtimeSeconds(join(seams.sessionsDir, `${record.sessionId}.json`));
		out.push({
			runtime: "dg",
			name: record.agentIdentity,
			handle,
			current: record.sessionId === sessionId,
			...(activeAt !== undefined ? { activeAt } : {}),
		});
	}
}

/** Every named local agent this machine can see, from whichever runtime stored the name. */
export function discoverAgents(seams: NameSeams): DiscoveredAgent[] {
	const out: DiscoveredAgent[] = [];
	const used = new Set<string>();
	claudeAgents(seams, out, used);
	codexAgents(seams, out, used);
	grokAgents(seams, out, used);
	dgAgents(seams, out, used);
	return out;
}
