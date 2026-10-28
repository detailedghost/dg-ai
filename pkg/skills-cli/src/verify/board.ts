import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSentinel } from "../prototype/sentinels";
import { assertVerifyName } from "./names";

export type VerdictStatus = "approved" | "changes" | "skip";

export interface Verdict {
	status: VerdictStatus;
	note: string;
	at: string;
}

export interface BoardImage {
	label: string;
	before: string;
	after: string;
	target?: string;
	reason?: string;
}

export interface SectionChecks {
	tests?: { status: string; summary: string };
	axe?: { violations: string[]; passes: number };
}

export interface Section {
	id: string;
	title: string;
	summary?: string;
	branch?: string;
	what_changed?: string;
	follows?: string;
	round?: number;
	item?: string;
	checks?: SectionChecks;
	images: BoardImage[];
}

export interface Pending {
	key: string;
	title: string;
	detail?: string;
	follows?: string;
}

export interface Board {
	name: string;
	sections: Section[];
	pending: Pending[];
}

export interface Chain {
	rounds: Section[];
	last: Section;
	waiting?: Pending;
}

export interface StatusRow {
	item: string;
	last: string;
	rounds: string[];
	done: boolean;
	note: string;
}

export interface StatusReport {
	allApproved: boolean;
	reviewed: boolean;
	items: StatusRow[];
}

export interface VerifyPaths {
	dir: string;
	manifest: string;
	board: string;
	verdicts: string;
	server: string;
	shotsDir: string;
}

const NOTE_MAX = 4000;
const STATUSES = new Set<string>(["approved", "changes", "skip"]);

export function verifyPaths(dir: string): VerifyPaths {
	return {
		dir,
		manifest: join(dir, "manifest.json"),
		board: join(dir, "board.json"),
		verdicts: join(dir, "verdicts.json"),
		server: join(dir, "server.json"),
		shotsDir: join(dir, "shots"),
	};
}

/** Resolve the session directory. An explicit dir is the session itself. */
export function resolveSessionDir(name: string, cwd: string, explicit?: string): string {
	assertVerifyName(name);
	if (explicit !== undefined && explicit.trim() !== "") return explicit;
	return join(cwd, ".agents", "verify", name);
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function writeJson(paths: VerifyPaths, file: string, value: unknown): void {
	mkdirSync(paths.dir, { recursive: true });
	writeSentinel(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function readBoard(paths: VerifyPaths, name: string): Board {
	const raw = readJson(paths.board);
	if (raw === undefined) return { name, sections: [], pending: [] };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("board.json must be an object");
	const record = raw as Partial<Board>;
	if (!Array.isArray(record.sections) || !Array.isArray(record.pending))
		throw new Error("board.json needs sections and pending arrays");
	return { name, sections: record.sections, pending: record.pending };
}

export function writeBoard(paths: VerifyPaths, board: Board): void {
	writeJson(paths, paths.board, board);
}

export function readVerdicts(paths: VerifyPaths): Record<string, Verdict> {
	const raw = readJson(paths.verdicts);
	if (raw === undefined) return {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("verdicts.json must be an object");
	const verdicts: Record<string, Verdict> = {};
	for (const [id, value] of Object.entries(raw)) {
		if (id.startsWith("_")) continue;
		const record = value as Partial<Verdict> | null;
		if (!record || !STATUSES.has(String(record.status)) || typeof record.note !== "string")
			throw new Error(`verdict for ${id} is incomplete`);
		verdicts[id] = { status: record.status as VerdictStatus, note: record.note, at: String(record.at ?? "") };
	}
	return verdicts;
}

export class VerifyRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** Validate a posted verdict batch against the board and merge it into verdicts.json. */
export function mergeVerdicts(paths: VerifyPaths, board: Board, body: unknown, at = new Date().toISOString()): void {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new VerifyRequestError("Invalid JSON", 400);
	const verdicts = readVerdicts(paths);
	for (const [id, value] of Object.entries(body)) {
		if (!board.sections.some((section) => section.id === id))
			throw new VerifyRequestError(`unknown section ${JSON.stringify(id)}`, 400);
		const record = value as Record<string, unknown> | null;
		const status = record?.status;
		if (typeof status !== "string" || !STATUSES.has(status))
			throw new VerifyRequestError("status must be approved, changes, or skip", 400);
		const note = typeof record?.note === "string" ? record.note.trim() : "";
		if (status === "changes" && !note) throw new VerifyRequestError("a note is required", 400);
		if (note.length > NOTE_MAX) throw new VerifyRequestError(`note must be at most ${NOTE_MAX} characters`, 400);
		verdicts[id] = { status: status as VerdictStatus, note, at };
	}
	writeJson(paths, paths.verdicts, verdicts);
}

const successorOf = (board: Board, section: Section) => board.sections.find((next) => next.follows === section.id);

/** Group sections into chains linked by follows, each with any pending next round. */
export function chains(board: Board): Chain[] {
	return board.sections
		.filter((section) => !section.follows || !board.sections.some((other) => other.id === section.follows))
		.map((root) => {
			const rounds = [root];
			for (let next = successorOf(board, root); next; next = successorOf(board, next)) rounds.push(next);
			const last = rounds[rounds.length - 1] ?? root;
			return { rounds, last, waiting: board.pending.find((entry) => entry.follows === last.id) };
		});
}

export function verdictLabel(verdict?: Verdict): string {
	if (!verdict) return "unreviewed";
	if (verdict.status === "approved") return verdict.note ? "approved+note" : "approved";
	return verdict.status === "changes" ? "sent back" : "skipped";
}

export const roundOf = (chain: Chain, index: number): number =>
	chain.rounds[index]?.round ?? (chain.rounds[0]?.round ?? 1) + index;

export function statusReport(board: Board, verdicts: Record<string, Verdict>): StatusReport {
	const items: StatusRow[] = chains(board).map((chain) => {
		const steps = chain.rounds.map((round, index) => `r${roundOf(chain, index)} ${verdictLabel(verdicts[round.id])}`);
		if (chain.waiting) steps.push(`r${roundOf(chain, chain.rounds.length - 1) + 1} working`);
		const note = [...chain.rounds].reverse().map((round) => verdicts[round.id]?.note).find(Boolean) ?? "";
		const latest = verdicts[chain.last.id];
		const done = !chain.waiting && latest?.status === "approved" && !latest.note;
		return { item: chain.last.title, last: chain.last.id, rounds: steps, done, note };
	});
	for (const entry of board.pending.filter((pending) => !pending.follows))
		items.push({ item: entry.title, last: entry.key, rounds: ["r1 working"], done: false, note: "" });
	return {
		allApproved: items.length > 0 && items.every((row) => row.done) && board.pending.length === 0,
		reviewed: board.sections.length > 0 && board.sections.every((section) => verdicts[section.id] !== undefined),
		items,
	};
}

export function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One line per item, then ALL APPROVED or the open count. */
export function formatStatus(report: StatusReport, json: boolean, noteMax = 160): string {
	if (json) return `${JSON.stringify(report)}\n`;
	const lines = report.items.map(
		(row) =>
			`${row.done ? "✓" : "·"} ${row.item} | ${row.rounds.join(" → ")}${row.note && !row.done ? ` | ${clip(row.note, noteMax)}` : ""}`,
	);
	lines.push(report.allApproved ? "ALL APPROVED" : `${report.items.filter((row) => !row.done).length} open`);
	return `${lines.join("\n")}\n`;
}

/** Add or replace a round and clear the pending entry it fulfills. */
export function addSection(board: Board, section: Section, pendingKey?: string): Board {
	if (section.follows && !board.sections.some((other) => other.id === section.follows))
		throw new Error(`follows ${section.follows} not found`);
	return {
		...board,
		sections: [...board.sections.filter((other) => other.id !== section.id), section],
		pending: board.pending.filter(
			(entry) => entry.key !== pendingKey && !(section.follows && entry.follows === section.follows),
		),
	};
}

export function setPending(board: Board, entry: Pending): Board {
	return { ...board, pending: [...board.pending.filter((other) => other.key !== entry.key), entry] };
}

export function dropPending(board: Board, key: string): Board {
	return { ...board, pending: board.pending.filter((entry) => entry.key !== key) };
}

/** Chains whose latest round was sent back or approved with a note and has no next round yet. */
export function reworkChains(board: Board, verdicts: Record<string, Verdict>): Chain[] {
	return chains(board).filter((chain) => {
		if (chain.waiting) return false;
		const verdict = verdicts[chain.last.id];
		return verdict?.status === "changes" || (verdict?.status === "approved" && verdict.note !== "");
	});
}
