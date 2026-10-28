import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeSentinel } from "../prototype/sentinels";
import type { VerifyManifest } from "./manifest";
import { assertVerifyName } from "./names";

export type Action = "approve" | "reject" | "tweak";
export type ReviewStatus = "pending" | "all-approved" | "needs-rework";

export interface Decision {
	action: Action;
	note: string;
	at: string;
}

export interface Notification {
	itemId: string;
	owner: string;
	action: "reject" | "tweak";
	note: string;
}

export interface VerdictItem {
	action: Action;
	note: string;
	owner: string;
}

export interface Verdict {
	name: string;
	status: "all-approved" | "needs-rework";
	allApproved: boolean;
	items: Record<string, VerdictItem>;
	notifications: Notification[];
}

export interface StatusItem {
	action: Action | "pending";
	note: string;
	owner: string;
}

export interface StatusReport {
	name: string;
	status: ReviewStatus;
	allApproved: boolean;
	claimed: boolean;
	items: Record<string, StatusItem>;
	notifications: Notification[];
}

export interface VerifyPaths {
	dir: string;
	manifest: string;
	decisions: string;
	verdict: string;
	claimed: string;
	reload: string;
	tests: string;
	notifyDir: string;
	shotsDir: string;
}

const NOTE_MAX = 4000;

export function verifyPaths(dir: string): VerifyPaths {
	return {
		dir,
		manifest: join(dir, "manifest.json"),
		decisions: join(dir, "decisions.json"),
		verdict: join(dir, "verdict.json"),
		claimed: join(dir, "claimed.json"),
		reload: join(dir, ".reload"),
		tests: join(dir, "tests.json"),
		notifyDir: join(dir, "notify"),
		shotsDir: join(dir, "shots"),
	};
}

/** Resolve the session directory. An explicit dir is the session itself. */
export function resolveSessionDir(name: string, cwd: string, explicit?: string): string {
	assertVerifyName(name);
	if (explicit !== undefined && explicit.trim() !== "") return explicit;
	return join(cwd, ".agents", "verify", name);
}

export function ensureSession(paths: VerifyPaths): void {
	mkdirSync(paths.dir, { recursive: true });
	mkdirSync(paths.shotsDir, { recursive: true });
	mkdirSync(paths.notifyDir, { recursive: true });
}

export function assertDecision(action: string, note: string): { action: Action; note: string } {
	if (action !== "approve" && action !== "reject" && action !== "tweak")
		throw new Error("action must be approve, reject, or tweak");
	const trimmed = note.trim();
	if ((action === "reject" || action === "tweak") && trimmed.length === 0)
		throw new Error("a note is required");
	if (trimmed.length > NOTE_MAX) throw new Error(`note must be at most ${NOTE_MAX} characters`);
	return { action, note: trimmed };
}

export function summarize(
	itemIds: readonly string[],
	decisions: Record<string, Decision>,
): { status: ReviewStatus; allApproved: boolean; pending: string[] } {
	const pending = itemIds.filter((id) => decisions[id] === undefined);
	if (pending.length > 0) return { status: "pending", allApproved: false, pending };
	const allApproved = itemIds.every((id) => decisions[id]?.action === "approve");
	return {
		status: allApproved ? "all-approved" : "needs-rework",
		allApproved,
		pending,
	};
}

export function reworkIds(decisions: Record<string, Decision>): string[] {
	return Object.entries(decisions)
		.filter(([, decision]) => decision.action === "reject" || decision.action === "tweak")
		.map(([id]) => id);
}

function isAction(value: unknown): value is Action {
	return value === "approve" || value === "reject" || value === "tweak";
}

export function readDecisions(paths: VerifyPaths): Record<string, Decision> {
	let text: string;
	try {
		text = readFileSync(paths.decisions, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("decisions.json must be an object");
	const decisions: Record<string, Decision> = {};
	for (const [id, value] of Object.entries(parsed)) {
		assertVerifyName(id, "item");
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error(`decision for ${id} must be an object`);
		const record = value as Record<string, unknown>;
		if (!isAction(record.action) || typeof record.note !== "string" || typeof record.at !== "string")
			throw new Error(`decision for ${id} is incomplete`);
		decisions[id] = { action: record.action, note: record.note, at: record.at };
	}
	return decisions;
}

export function writeDecisions(paths: VerifyPaths, decisions: Record<string, Decision>): void {
	ensureSession(paths);
	writeSentinel(paths.decisions, `${JSON.stringify(decisions)}\n`);
}

function notificationPath(paths: VerifyPaths, itemId: string): string {
	return join(paths.notifyDir, `${assertVerifyName(itemId, "item")}.json`);
}

export function writeNotification(
	paths: VerifyPaths,
	itemId: string,
	owner: string,
	decision: { action: Action; note: string },
): void {
	ensureSession(paths);
	const file = notificationPath(paths, itemId);
	if (decision.action === "approve") {
		rmSync(file, { force: true });
		return;
	}
	const body: Notification = {
		itemId,
		owner,
		action: decision.action,
		note: decision.note,
	};
	writeSentinel(file, `${JSON.stringify(body)}\n`);
}

export function readNotifications(paths: VerifyPaths, manifest: VerifyManifest): Notification[] {
	const notes: Notification[] = [];
	for (const item of manifest.items) {
		const file = notificationPath(paths, item.id);
		if (!existsSync(file)) continue;
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error(`notification for ${item.id} must be an object`);
		const record = parsed as Record<string, unknown>;
		if (record.itemId !== item.id || typeof record.note !== "string")
			throw new Error(`notification for ${item.id} does not match the item`);
		if (record.action !== "reject" && record.action !== "tweak")
			throw new Error(`notification for ${item.id} has no rework action`);
		if (record.owner !== item.owner)
			throw new Error(`notification for ${item.id} names a different owner`);
		notes.push({
			itemId: item.id,
			owner: item.owner,
			action: record.action,
			note: record.note,
		});
	}
	return notes;
}

export function buildVerdict(manifest: VerifyManifest, decisions: Record<string, Decision>): Verdict {
	const ids = manifest.items.map((item) => item.id);
	const summary = summarize(ids, decisions);
	if (summary.status === "pending") throw new Error("verdict requires a decision for every item");
	const items: Record<string, VerdictItem> = {};
	for (const item of manifest.items) {
		const decision = decisions[item.id];
		if (!decision) throw new Error(`missing decision for ${item.id}`);
		items[item.id] = { action: decision.action, note: decision.note, owner: item.owner };
	}
	const notifications = manifest.items.flatMap((item) => {
		const decision = decisions[item.id];
		if (!decision || decision.action === "approve") return [];
		return [{ itemId: item.id, owner: item.owner, action: decision.action, note: decision.note }];
	});
	return {
		name: manifest.name,
		status: summary.status,
		allApproved: summary.allApproved,
		items,
		notifications,
	};
}

export function publishVerdict(paths: VerifyPaths, manifest: VerifyManifest): Verdict | undefined {
	const decisions = readDecisions(paths);
	const summary = summarize(
		manifest.items.map((item) => item.id),
		decisions,
	);
	if (summary.status === "pending") {
		rmSync(paths.verdict, { force: true });
		return undefined;
	}
	if (existsSync(paths.claimed)) return undefined;
	const verdict = buildVerdict(manifest, decisions);
	ensureSession(paths);
	writeSentinel(paths.verdict, `${JSON.stringify(verdict)}\n`);
	return verdict;
}

function readVerdictFile(file: string): Verdict {
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("verdict must be an object");
	const record = parsed as Record<string, unknown>;
	if (typeof record.name !== "string" || typeof record.allApproved !== "boolean")
		throw new Error("verdict is incomplete");
	if (record.status !== "all-approved" && record.status !== "needs-rework")
		throw new Error("verdict status is invalid");
	if (!record.items || typeof record.items !== "object" || Array.isArray(record.items))
		throw new Error("verdict items must be an object");
	return parsed as Verdict;
}

/** Claim a finished verdict. A later call reprints the claim until rerun clears it. */
export function claimVerdict(paths: VerifyPaths): Verdict | undefined {
	if (!existsSync(paths.verdict)) {
		if (!existsSync(paths.claimed)) return undefined;
		return readVerdictFile(paths.claimed);
	}
	const verdict = readVerdictFile(paths.verdict);
	writeSentinel(paths.claimed, `${JSON.stringify(verdict)}\n`);
	rmSync(paths.verdict, { force: true });
	return verdict;
}

export function clearClaim(paths: VerifyPaths): void {
	rmSync(paths.verdict, { force: true });
	rmSync(paths.claimed, { force: true });
}

/** Drop picked items so a rerun can collect a new verdict for them. */
export function forgetItems(paths: VerifyPaths, ids: readonly string[]): void {
	const decisions = readDecisions(paths);
	for (const id of ids) {
		const name = assertVerifyName(id, "item");
		delete decisions[name];
		rmSync(join(paths.notifyDir, `${name}.json`), { force: true });
	}
	writeDecisions(paths, decisions);
	clearClaim(paths);
}

export function readReload(paths: VerifyPaths): number {
	try {
		const value = Number.parseInt(readFileSync(paths.reload, "utf8").trim(), 10);
		return Number.isSafeInteger(value) && value >= 0 ? value : 0;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
		throw error;
	}
}

export function writeReload(paths: VerifyPaths, token: number): string {
	if (!Number.isSafeInteger(token) || token < 1) throw new Error("reload token must be a positive integer");
	ensureSession(paths);
	const text = String(token);
	writeSentinel(paths.reload, `${text}\n`);
	return text;
}

export function bumpReload(paths: VerifyPaths): string {
	return writeReload(paths, readReload(paths) + 1);
}

export function statusReport(paths: VerifyPaths, manifest: VerifyManifest): StatusReport {
	const decisions = readDecisions(paths);
	const summary = summarize(
		manifest.items.map((item) => item.id),
		decisions,
	);
	const items: Record<string, StatusItem> = {};
	for (const item of manifest.items) {
		const decision = decisions[item.id];
		items[item.id] = decision
			? { action: decision.action, note: decision.note, owner: item.owner }
			: { action: "pending", note: "", owner: item.owner };
	}
	return {
		name: manifest.name,
		status: summary.status,
		allApproved: summary.allApproved,
		claimed: existsSync(paths.claimed),
		items,
		notifications: readNotifications(paths, manifest),
	};
}

export function formatStatus(report: StatusReport, json: boolean): string {
	if (json) return `${JSON.stringify(report)}\n`;
	const lines: string[] = [report.status];
	for (const [id, item] of Object.entries(report.items)) {
		if (item.action === "pending") {
			lines.push(`${id} pending owner=${item.owner}`);
			continue;
		}
		lines.push(`${id} ${item.action} owner=${item.owner}`);
		if (item.note) lines.push(item.note);
	}
	lines.push(`allApproved ${report.allApproved ? "true" : "false"}`);
	lines.push(`claimed ${report.claimed ? "true" : "false"}`);
	return `${lines.join("\n")}\n`;
}

export function formatVerdict(verdict: Verdict, json: boolean): string {
	if (json) return `${JSON.stringify(verdict)}\n`;
	const lines: string[] = [verdict.status];
	for (const [id, item] of Object.entries(verdict.items)) {
		lines.push(`${id} ${item.action} owner=${item.owner}`);
		if (item.note) lines.push(item.note);
	}
	lines.push(`allApproved ${verdict.allApproved ? "true" : "false"}`);
	return `${lines.join("\n")}\n`;
}

export class VerifyRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** Record one item pick. A claimed review stays closed until rerun. */
export function applyDecision(
	paths: VerifyPaths,
	manifest: VerifyManifest,
	itemId: string,
	action: string,
	note: string,
	at = new Date().toISOString(),
): void {
	if (existsSync(paths.claimed))
		throw new VerifyRequestError("This review is already claimed.", 409);
	const item = manifest.items.find((entry) => entry.id === itemId);
	if (!item) throw new VerifyRequestError(`unknown item ${JSON.stringify(itemId)}`, 400);
	let decision: { action: Action; note: string };
	try {
		decision = assertDecision(action, note);
	} catch (error) {
		throw new VerifyRequestError(error instanceof Error ? error.message : String(error), 400);
	}
	const decisions = readDecisions(paths);
	decisions[item.id] = { action: decision.action, note: decision.note, at };
	writeDecisions(paths, decisions);
	writeNotification(paths, item.id, item.owner, decision);
	publishVerdict(paths, manifest);
}
