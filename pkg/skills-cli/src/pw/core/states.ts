import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { stateDir } from "@dg/common/node";
import type { Cookie } from "playwright-core";
import { UsageError } from "./args";

export const STATE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const LEGACY_MARKER = ".legacy-imported";
const LEGACY_LABEL = "~/.cache/playwright-cli/sessions/";
const TOP_DOMAINS = 3;

export type StoredOrigin = {
	origin: string;
	localStorage?: { name: string; value: string }[];
	indexedDB?: unknown[];
};
export type StorageState = { cookies?: Cookie[]; origins?: StoredOrigin[] };

export type StateSummary = {
	name: string;
	cookies: number;
	origins: number;
	domains: string[];
	savedAt: string;
};

export class StateNotFoundError extends Error {
	constructor(name: string) {
		super(`No saved state '${name}'. Run: pw state list`);
	}
}

export function parseStorageState(text: string, file: string): StorageState {
	let state: unknown;
	try {
		state = JSON.parse(text);
	} catch {
		throw new Error(`Not a storage state file: ${file}`);
	}
	const candidate = state as StorageState | null;
	const valid =
		typeof candidate === "object" &&
		candidate !== null &&
		(candidate.cookies === undefined || Array.isArray(candidate.cookies)) &&
		(candidate.origins === undefined || Array.isArray(candidate.origins)) &&
		(candidate.cookies !== undefined || candidate.origins !== undefined);
	if (!valid) throw new Error(`Not a storage state file: ${file}`);
	return candidate;
}

export function validateName(name: string): string {
	if (!STATE_NAME.test(name)) throw new UsageError(`state name must match ${STATE_NAME.source}`);
	return name;
}

export function statesDir(): string {
	const dir = path.join(stateDir("pw", { cwdScope: false }), "states");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

export const statePathFor = (name: string): string => path.join(statesDir(), `${validateName(name)}.json`);

function legacyDir(): string {
	const cache = process.env["XDG_CACHE_HOME"] ?? path.join(homedir(), ".cache");
	return path.join(cache, "playwright-cli", "sessions");
}

function writeAtomicPrivate(file: string, text: string): void {
	const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
	try {
		writeFileSync(temp, text, { mode: 0o600 });
		chmodSync(temp, 0o600);
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export function save(name: string, state: StorageState): void {
	writeAtomicPrivate(statePathFor(name), `${JSON.stringify(state, null, 2)}\n`);
}

export function load(name: string): StorageState {
	const file = statePathFor(name);
	if (!existsSync(file)) throw new StateNotFoundError(name);
	return parseStorageState(readFileSync(file, "utf8"), file);
}

export function remove(name: string): void {
	const file = statePathFor(name);
	if (!existsSync(file)) throw new StateNotFoundError(name);
	rmSync(file);
}

function summarize(name: string, state: StorageState, savedAt: Date): StateSummary {
	const counts = new Map<string, number>();
	for (const cookie of state.cookies ?? []) {
		const domain = (cookie.domain ?? "").replace(/^\./, "");
		if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
	}
	const domains = [...counts]
		.sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))
		.slice(0, TOP_DOMAINS)
		.map(([domain]) => domain);
	return {
		name,
		cookies: state.cookies?.length ?? 0,
		origins: state.origins?.length ?? 0,
		domains,
		savedAt: savedAt.toISOString(),
	};
}

export function list(): StateSummary[] {
	const dir = statesDir();
	const summaries: StateSummary[] = [];
	for (const file of readdirSync(dir).sort()) {
		const name = file.slice(0, -".json".length);
		if (!file.endsWith(".json") || !STATE_NAME.test(name)) continue;
		try {
			const full = path.join(dir, file);
			summaries.push(summarize(name, parseStorageState(readFileSync(full, "utf8"), full), statSync(full).mtime));
		} catch {}
	}
	return summaries;
}

export function formatSummary(summary: StateSummary): string {
	const domains = summary.domains.length > 0 ? summary.domains.join(",") : "-";
	return `${summary.name}  ${summary.cookies} cookies  ${summary.origins} origins  ${domains}  ${summary.savedAt}`;
}

export function importFile(file: string, name?: string): string {
	const target = validateName(name ?? path.basename(file).replace(/\.json$/, ""));
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`File not found: ${file}`);
		throw error;
	}
	parseStorageState(text, file);
	writeAtomicPrivate(statePathFor(target), text);
	return target;
}

export function importLegacyOnce(out: (text: string) => void): number {
	const dir = statesDir();
	const marker = path.join(dir, LEGACY_MARKER);
	if (existsSync(marker)) return 0;

	let imported = 0;
	const source = legacyDir();
	for (const file of existsSync(source) ? readdirSync(source).sort() : []) {
		const name = file.slice(0, -".json".length);
		const target = path.join(dir, file);
		if (!file.endsWith(".json") || !STATE_NAME.test(name) || existsSync(target)) continue;
		const from = path.join(source, file);
		try {
			const text = readFileSync(from, "utf8");
			parseStorageState(text, from);
			writeAtomicPrivate(target, text);
			const { atime, mtime } = statSync(from);
			utimesSync(target, atime, mtime);
			imported++;
		} catch {}
	}
	writeFileSync(marker, "", { mode: 0o600 });
	if (imported > 0) out(`Imported ${imported} legacy states from ${LEGACY_LABEL}`);
	return imported;
}
