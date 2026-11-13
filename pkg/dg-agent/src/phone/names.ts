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

/** The running agent's handle. A Claude, Codex, or Grok name wins over a dg session; none means unset. */
export function currentSelfName(agents: readonly DiscoveredAgent[]): string | undefined {
	const order: readonly AgentRuntime[] = ["claude", "codex", "grok", "dg"];
	for (const runtime of order) {
		const hit = agents.find((agent) => agent.current && agent.runtime === runtime);
		if (hit) return hit.handle;
	}
	return undefined;
}

/** Current agents first, then the rest in handle order, one row per handle, capped. */
export function namesForRoster(agents: readonly DiscoveredAgent[], limit: number): DiscoveredAgent[] {
	if (limit <= 0) return [];
	const ranked = [...agents].sort((left, right) => {
		if (left.current !== right.current) return left.current ? -1 : 1;
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
/** `{name}` from a Claude session file. `current` when the file is the session id this process is. */
export function claudeNameFromJson(text: string, sessionId: string | undefined): { name: string; current: boolean } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const name = trimmed(value.name);
	if (name === undefined) return undefined;
	const id = trimmed(sessionId);
	return { name, current: id !== undefined && text.includes(id) };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = trimmed(record[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

/** One `session_index.jsonl` line. `thread_name`, then `name`, then `title`. */
export function codexNameFromLine(line: string, threadId: string | undefined): { name: string; current: boolean } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) return undefined;
	const name = firstString(value, ["thread_name", "name", "title"]);
	if (name === undefined) return undefined;
	const id = firstString(value, ["id", "thread_id"]);
	const current = threadId !== undefined && threadId !== "" && id === threadId;
	return { name, current };
}

function pushNamed(
	out: DiscoveredAgent[],
	runtime: AgentRuntime,
	name: string,
	current: boolean,
): void {
	const handle = slugHandle(name);
	if (handle === undefined) return;
	out.push({ runtime, name, handle, current });
}

function claudeAgents(seams: NameSeams, out: DiscoveredAgent[]): void {
	const home = seams.homeDir;
	if (home === undefined) return;
	const config = seams.env.CLAUDE_CONFIG_DIR;
	const root = config && isAbsolute(config) ? config : join(home, ".claude");
	const sessionId = trimmed(seams.env.CLAUDE_CODE_SESSION_ID) ?? trimmed(seams.env.CLAUDE_SESSION_ID);
	for (const path of walkJson(join(root, "sessions"), FILE_CAP, 0)) {
		const text = readCapped(path, FILE_BYTES);
		if (text === undefined) continue;
		const parsed = claudeNameFromJson(text, sessionId);
		if (parsed) pushNamed(out, "claude", parsed.name, parsed.current);
	}
}

function codexAgents(seams: NameSeams, out: DiscoveredAgent[]): void {
	const home = seams.homeDir;
	if (home === undefined) return;
	const configured = seams.env.CODEX_HOME;
	const root = configured && isAbsolute(configured) ? configured : join(home, ".codex");
	const text = readCapped(join(root, "session_index.jsonl"), INDEX_BYTES);
	if (text === undefined) return;
	const threadId = trimmed(seams.env.CODEX_THREAD_ID);
	const lines = text.split(/\r?\n/).slice(0, INDEX_LINES);
	for (const line of lines) {
		if (line.trim() === "") continue;
		const parsed = codexNameFromLine(line, threadId);
		if (parsed) pushNamed(out, "codex", parsed.name, parsed.current);
	}
}

function grokAgents(seams: NameSeams, out: DiscoveredAgent[]): void {
	const agent = trimmed(seams.env.GROK_AGENT_NAME);
	const bot = trimmed(seams.env.GROK_BOT_NAME);
	if (agent !== undefined) pushNamed(out, "grok", agent, true);
	if (bot !== undefined && bot !== agent) pushNamed(out, "grok", bot, agent === undefined);
	const home = seams.homeDir;
	if (home === undefined) return;
	const configured = seams.env.GROK_HOME;
	const root = configured && isAbsolute(configured) ? configured : join(home, ".grok");
	for (const path of walkJson(join(root, "agents"), FILE_CAP, 0)) {
		const text = readCapped(path, FILE_BYTES);
		if (text === undefined) continue;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			continue;
		}
		if (!isRecord(value)) continue;
		const name = trimmed(value.name);
		if (name === undefined || name === agent || name === bot) continue;
		pushNamed(out, "grok", name, false);
	}
}

function dgAgents(seams: NameSeams, out: DiscoveredAgent[]): void {
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
		pushNamed(out, "dg", record.agentIdentity, record.sessionId === sessionId);
	}
}

/** Every named local agent this machine can see, from whichever runtime stored the name. */
export function discoverAgents(seams: NameSeams): DiscoveredAgent[] {
	const out: DiscoveredAgent[] = [];
	claudeAgents(seams, out);
	codexAgents(seams, out);
	grokAgents(seams, out);
	dgAgents(seams, out);
	return out;
}
