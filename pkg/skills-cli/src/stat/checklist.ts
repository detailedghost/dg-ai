import { CLI_PATH } from "../doctor/probes";
import {
	type ChecklistItem,
	type ChecklistModel,
	emptyModel,
	type EtaBucket,
	etaRank,
	isEmptyModel,
	isStatus,
	type Owner,
	ownerFor,
	type Status,
	STATUS_EMOJI,
} from "./model";

export const DONE_DISPLAY_CAP = 10;

/** Any indent is a child. New files use the parent number's width; older files used 3 spaces. */
const ITEM_LINE = /^( *)(\d+)\.\s\[( |x)\]\s([a-z-]+):\s(.*)$/;
const ETA_SUFFIX = /^(.*) \[(<5 min|~15 min|~30 min|~1 hr|>1 hr|unknown)\]$/;
/** A trailing bucket written with a backslash is literal text, not an ETA. One backslash is removed on read. */
const ESCAPED_ETA_SUFFIX = /^(.*)\\(\[(<5 min|~15 min|~30 min|~1 hr|>1 hr|unknown)\])$/;

export function sanitizeText(text: string): string {
	return text.replace(/[\t\r\n\u2028\u2029]+/g, " ").trim();
}

function toAscii(text: string): string {
	return Array.from(text)
		.map((ch) => ((ch.codePointAt(0) ?? 0) < 0x80 ? ch : "?"))
		.join("");
}

function tsvField(value: string): string {
	return toAscii(value.replace(/[\t\r\n]+/g, " "));
}

/** Escapes a trailing ETA-shaped suffix so a later read does not treat it as metadata. */
function encodeItemText(text: string): string {
	if (!ETA_SUFFIX.test(text) && !ESCAPED_ETA_SUFFIX.test(text)) return text;
	return text.replace(/\[(?=[^[\]]*\]$)/, "\\[");
}

function decodeItemText(text: string): string {
	const match = ESCAPED_ETA_SUFFIX.exec(text);
	if (!match) return text;
	return `${match[1] ?? ""}${match[2] ?? ""}`;
}

function splitEta(raw: string): { text: string; eta?: EtaBucket } {
	const match = ETA_SUFFIX.exec(raw);
	if (!match) return { text: decodeItemText(raw) };
	return { text: decodeItemText(match[1] ?? raw), eta: match[2] as EtaBucket };
}

function parseItemLine(
	statusWord: string,
	rest: string,
): { status: Status; text: string; eta?: EtaBucket } {
	if (!isStatus(statusWord)) {
		throw new Error(
			`stat checklist: unrecognized status "${statusWord}" in the stored checklist`,
		);
	}
	const { text, eta } = splitEta(rest);
	return { status: statusWord, text, eta };
}

/** Line order carries meaning; the leading numbers are cosmetic and regenerated on every write. */
export function parseChecklist(raw: string): ChecklistModel {
	const model = emptyModel();
	let currentParent: ChecklistItem | null = null;
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		const match = ITEM_LINE.exec(line);
		if (!match) continue;
		const indent = match[1] ?? "";
		const parsed = parseItemLine(match[4] ?? "", match[5] ?? "");
		const item: ChecklistItem = {
			text: parsed.text,
			status: parsed.status,
			eta: parsed.eta,
			children: [],
		};
		if (indent.length > 0) {
			if (!currentParent) continue;
			currentParent.children.push(item);
			continue;
		}
		currentParent = item;
		if (parsed.status === "done") model.done.push(item);
		else model.open.push(item);
	}
	return model;
}

function formatItemLine(order: string, indent: string, item: ChecklistItem): string {
	const box = item.status === "done" ? "x" : " ";
	const etaSuffix = item.status !== "done" && item.eta ? ` [${item.eta}]` : "";
	return `${indent}${order}. [${box}] ${item.status}: ${encodeItemText(item.text)}${etaSuffix}`;
}

/** Spaces that put a nested GFM task inside the parent item: digits, the dot, and the following space. */
function childIndent(parentNumber: string): string {
	return " ".repeat(parentNumber.length + 2);
}

/** Canonical on-disk format. Same item lines as `--plain` aside from its Total line, ASCII folding, and a backslash when text itself ends in an ETA bucket. */
export function serializeChecklist(model: ChecklistModel): string {
	const lines: string[] = [];
	let n = 0;
	const push = (item: ChecklistItem) => {
		n++;
		const order = String(n);
		lines.push(formatItemLine(order, "", item));
		const indent = childIndent(order);
		for (const [i, child] of item.children.entries())
			lines.push(formatItemLine(String(i + 1), indent, child));
	};
	for (const item of model.open) push(item);
	if (model.open.length > 0 && model.done.length > 0) lines.push("");
	for (const item of model.done) push(item);
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export interface FlatRow {
	order: string;
	owner: Owner | null;
	status: Status;
	text: string;
	eta?: EtaBucket;
}

function hasUnfinishedChild(item: ChecklistItem): boolean {
	return item.children.some((child) => child.status !== "done");
}

export function flattenForDisplay(
	model: ChecklistModel,
	cap = DONE_DISPLAY_CAP,
): { rows: FlatRow[]; hiddenDoneCount: number } {
	const hiddenDone = new Set<number>();
	model.done.forEach((item, index) => {
		if (index >= cap && !hasUnfinishedChild(item)) hiddenDone.add(index);
	});
	const rows: FlatRow[] = [];
	for (const entry of locateAll(model)) {
		const hidden =
			(entry.scope === "done-top" || entry.scope === "done-child") && hiddenDone.has(entry.topIndex);
		if (hidden) continue;
		rows.push({
			order: entry.label,
			owner: ownerFor(entry.item.status),
			status: entry.item.status,
			text: entry.item.text,
			eta: entry.item.eta,
		});
	}
	return { rows, hiddenDoneCount: hiddenDone.size };
}

export interface TotalResult {
	bucket: EtaBucket;
	label?: { order: string; text: string };
}

function topLevelOrderOf(label: string): string {
	const dot = label.indexOf(".");
	return dot === -1 ? label : label.slice(0, dot);
}

/**
 * `--long` prints `-` in ORDER for every sub-item, so the total cites the parent number a reader can see.
 * "2 child" reads as an item named child; "child, under 2" names the work and the parent it sits under.
 */
function longCriticalPath(label: { order: string; text: string }): string {
	const text = tsvField(label.text);
	const top = topLevelOrderOf(label.order);
	return label.order.includes(".") ? `${text}, under ${top}` : `${top} ${text}`;
}

interface Best {
	bucket: EtaBucket;
	item: ChecklistItem;
	topIndex: number;
	inOpen: boolean;
}

function findCritical(model: ChecklistModel): { anyUnfinished: boolean; best: Best | null } {
	let anyUnfinished = false;
	let best: Best | null = null;
	for (const entry of storedEntries(model)) {
		const { item } = entry;
		if (item.status === "done") continue;
		anyUnfinished = true;
		if (item.status === "parked") continue;
		if (ownerFor(item.status) !== "agent") continue;
		if (!item.eta || item.eta === "unknown") continue;
		if (!best || etaRank(item.eta) > etaRank(best.bucket)) {
			best = {
				bucket: item.eta,
				item,
				topIndex: entry.topIndex,
				inOpen: entry.scope === "open-top" || entry.scope === "open-child",
			};
		}
	}
	return { anyUnfinished, best };
}

/** The unfinished agent item with the largest known ETA names the critical path. Parked work is excluded. Ties keep stored order. */
export function computeTotal(model: ChecklistModel): TotalResult | null {
	const { anyUnfinished, best } = findCritical(model);
	if (!anyUnfinished) return null;
	if (!best) return { bucket: "unknown" };
	const label = locateAll(model).find((entry) => entry.item === best.item)?.label ?? "";
	return { bucket: best.bucket, label: { order: label, text: best.item.text } };
}

export function countWaitingOnUser(model: ChecklistModel): number {
	return storedEntries(model).filter((entry) => ownerFor(entry.item.status) === "user").length;
}

function waitingLine(model: ChecklistModel, prefix: string): string | null {
	const count = countWaitingOnUser(model);
	if (count === 0) return null;
	const noun = count === 1 ? "item" : "items";
	return `${prefix}Waiting on you: ${count} ${noun}. Run /dg:walk stat to walk them.`;
}

function totalLine(total: TotalResult | null, prefix: string): string | null {
	if (!total) return null;
	const body = total.label
		? `Total: ${total.bucket} (critical path: ${total.label.order} ${total.label.text})`
		: "Total: unknown";
	return `${prefix}${body}`;
}

function noChecklistMessage(): string {
	return `No checklist yet. Add one with: ${CLI_PATH} stat add "<text>"`;
}

function displayNumber(order: string): string {
	const dot = order.indexOf(".");
	return dot === -1 ? order : order.slice(dot + 1);
}

function indentFor(order: string): string {
	const dot = order.indexOf(".");
	return dot === -1 ? "" : childIndent(order.slice(0, dot));
}

export function renderEmoji(model: ChecklistModel): string {
	if (isEmptyModel(model)) return `${noChecklistMessage()}\n`;
	const { rows, hiddenDoneCount } = flattenForDisplay(model);
	const lines = rows.map((row) => {
		const etaSuffix =
			row.owner === "agent" && row.status !== "done" && row.eta ? ` [${row.eta}]` : "";
		return `${indentFor(row.order)}${displayNumber(row.order)}. ${STATUS_EMOJI[row.status]} ${row.text}${etaSuffix}`;
	});
	if (hiddenDoneCount > 0) lines.push(`...and ${hiddenDoneCount} more done`);
	const total = totalLine(computeTotal(model), "");
	if (total) lines.push("", total);
	const waiting = waitingLine(model, "");
	if (waiting) lines.push(waiting);
	return `${lines.join("\n")}\n`;
}

export function renderPlain(model: ChecklistModel): string {
	if (isEmptyModel(model)) return toAscii(`${noChecklistMessage()}\n`);
	const { rows, hiddenDoneCount } = flattenForDisplay(model);
	const lines = rows.map((row) => {
		const box = row.status === "done" ? "x" : " ";
		const etaSuffix =
			row.owner === "agent" && row.status !== "done" && row.eta ? ` [${row.eta}]` : "";
		return `${indentFor(row.order)}${displayNumber(row.order)}. [${box}] ${row.status}: ${row.text}${etaSuffix}`;
	});
	if (hiddenDoneCount > 0) lines.push(`...and ${hiddenDoneCount} more done`);
	const total = totalLine(computeTotal(model), "# ");
	if (total) lines.push("", total);
	const waiting = waitingLine(model, "");
	if (waiting) lines.push(waiting);
	return toAscii(`${lines.join("\n")}\n`);
}

const LONG_HEADER = "ORDER\tOWNER\tSTATUS\tWORK\tDETAIL\tPR/MR\tETA";

export function renderLong(model: ChecklistModel): string {
	const lines = [LONG_HEADER];
	if (isEmptyModel(model)) {
		lines.push(`# ${noChecklistMessage()}`);
		return `${lines.join("\n")}\n`;
	}
	const { rows, hiddenDoneCount } = flattenForDisplay(model);
	for (const row of rows) {
		const owner = row.owner ?? "-";
		const eta = row.owner === "agent" && row.status !== "done" && row.eta ? row.eta : "-";
		const order = row.order.includes(".") ? "-" : row.order;
		lines.push([order, owner, row.status, tsvField(row.text), "-", "-", eta].join("\t"));
	}
	if (hiddenDoneCount > 0) lines.push(`# ...and ${hiddenDoneCount} more done`);
	const total = computeTotal(model);
	if (total) {
		const line = total.label
			? `# Total: ${total.bucket} (critical path: ${longCriticalPath(total.label)})`
			: "# Total: unknown";
		lines.push(line);
	}
	const waiting = waitingLine(model, "# ");
	if (waiting) lines.push(waiting);
	return `${lines.join("\n")}\n`;
}

export interface JsonItem {
	order: string;
	owner: Owner | null;
	status: Status;
	text: string;
	eta: EtaBucket | null;
	children: JsonItem[];
}

export interface JsonChecklist {
	open: JsonItem[];
	done: JsonItem[];
	total: { bucket: EtaBucket; order: string | null; text: string | null } | null;
}

function toJsonItem(item: ChecklistItem, order: string): JsonItem {
	return {
		order,
		owner: ownerFor(item.status),
		status: item.status,
		text: item.text,
		eta: item.status === "done" ? null : item.eta ?? null,
		children: item.children.map((child, i) => toJsonItem(child, `${order}.${i + 1}`)),
	};
}

export function renderJsonModel(model: ChecklistModel): JsonChecklist {
	const open = displayOpen(model).map((item, i) => toJsonItem(item, String(i + 1)));
	let n = model.open.length;
	const done = model.done.map((item) => {
		n++;
		return toJsonItem(item, String(n));
	});
	const total = computeTotal(model);
	return {
		open,
		done,
		total: total
			? { bucket: total.bucket, order: total.label?.order ?? null, text: total.label?.text ?? null }
			: null,
	};
}

export interface MatchFailure {
	ok: false;
	candidates: { label: string; text: string }[];
}

export interface PlacementFailure {
	ok: false;
	placement: { wanted: number; landsAt: number };
}

interface Located {
	item: ChecklistItem;
	label: string;
	scope: "open-top" | "open-child" | "done-top" | "done-child";
	topIndex: number;
}

const GROUP_BLOCKED = 0;
const GROUP_CRITICAL = 1;
const GROUP_AGENT = 2;
const GROUP_PARKED = 3;
const GROUP_NEEDS_USER = 4;

function isAgentBucket(item: ChecklistItem): boolean {
	return item.status !== "blocked-user" && item.status !== "needs-user" && item.status !== "parked";
}

function chainRank(item: ChecklistItem): number {
	let rank = 0;
	for (const member of [item, ...item.children]) {
		if (member.status === "done" || member.status === "parked") continue;
		if (ownerFor(member.status) !== "agent" || !member.eta) continue;
		rank = Math.max(rank, etaRank(member.eta));
	}
	return rank;
}

/** Open top-level items in display order: blocked-user, critical chain, other chains by ETA, parked, needs-user. Ties keep stored order. */
function displayEntries(model: ChecklistModel): { item: ChecklistItem; topIndex: number }[] {
	const { best } = findCritical(model);
	const critical =
		best?.inOpen && isAgentBucket(model.open[best.topIndex] as ChecklistItem)
			? best.topIndex
			: undefined;
	const keyed = model.open.map((item, topIndex) => {
		let group = GROUP_AGENT;
		if (item.status === "blocked-user") group = GROUP_BLOCKED;
		else if (topIndex === critical) group = GROUP_CRITICAL;
		else if (item.status === "needs-user") group = GROUP_NEEDS_USER;
		else if (item.status === "parked") group = GROUP_PARKED;
		return { item, topIndex, group, rank: group === GROUP_AGENT ? chainRank(item) : 0 };
	});
	const hasEta = (rank: number) => (rank > 0 ? 0 : 1);
	keyed.sort(
		(a, b) =>
			a.group - b.group ||
			hasEta(a.rank) - hasEta(b.rank) ||
			b.rank - a.rank ||
			a.topIndex - b.topIndex,
	);
	return keyed;
}

function displayOpen(model: ChecklistModel): ChecklistItem[] {
	return displayEntries(model).map((entry) => entry.item);
}

function collect(
	open: { item: ChecklistItem; topIndex: number }[],
	done: ChecklistItem[],
): Located[] {
	const out: Located[] = [];
	let n = 0;
	for (const { item, topIndex } of open) {
		n++;
		out.push({ item, label: String(n), scope: "open-top", topIndex });
		item.children.forEach((child, i) =>
			out.push({ item: child, label: `${n}.${i + 1}`, scope: "open-child", topIndex }),
		);
	}
	done.forEach((item, topIndex) => {
		n++;
		out.push({ item, label: String(n), scope: "done-top", topIndex });
		item.children.forEach((child, i) =>
			out.push({ item: child, label: `${n}.${i + 1}`, scope: "done-child", topIndex }),
		);
	});
	return out;
}

function storedEntries(model: ChecklistModel): Located[] {
	return collect(
		model.open.map((item, topIndex) => ({ item, topIndex })),
		model.done,
	);
}

function locateAll(model: ChecklistModel): Located[] {
	return collect(displayEntries(model), model.done);
}

export function textAtLabel(model: ChecklistModel, label: string): string {
	return locateAll(model).find((entry) => entry.label === label)?.item.text ?? "";
}

function resolveOne(
	located: Located[],
	needle: string,
): { ok: true; hit: Located } | MatchFailure {
	const lower = needle.toLowerCase();
	const hits = located.filter((entry) => entry.item.text.toLowerCase().includes(lower));
	if (hits.length !== 1) {
		return { ok: false, candidates: hits.map((h) => ({ label: h.label, text: h.item.text })) };
	}
	return { ok: true, hit: hits[0] as Located };
}

function resolveByPosition(
	located: Located[],
	n: number,
): { ok: true; hit: Located } | MatchFailure {
	const hit = located.find((entry) => entry.label === String(n));
	return hit ? { ok: true, hit } : { ok: false, candidates: [] };
}

export interface MutationResult {
	ok: true;
	model: ChecklistModel;
	label: string;
}

/** Marks the one unfinished item matching `match` as done, wherever its parent lives. A parent's children move with it. Already-done items are not candidates. */
export function markDone(model: ChecklistModel, match: string): MutationResult | MatchFailure {
	const located = locateAll(model).filter((entry) => entry.item.status !== "done");
	const resolved = resolveOne(located, match);
	if (!resolved.ok) return resolved;
	const { hit } = resolved;
	if (hit.scope === "open-child" || hit.scope === "done-child") {
		const inOpen = hit.scope === "open-child";
		const parentList = inOpen ? model.open : model.done;
		const parent = parentList[hit.topIndex] as ChecklistItem;
		const children = parent.children.map((child) =>
			child === hit.item ? { ...child, status: "done" as const, eta: undefined } : child,
		);
		const updatedParent = { ...parent, children };
		const open = inOpen
			? model.open.map((item, i) => (i === hit.topIndex ? updatedParent : item))
			: model.open;
		const done = inOpen
			? model.done
			: model.done.map((item, i) => (i === hit.topIndex ? updatedParent : item));
		return { ok: true, model: { open, done }, label: hit.label };
	}
	const doneItem: ChecklistItem = {
		...(model.open[hit.topIndex] as ChecklistItem),
		status: "done",
		eta: undefined,
	};
	const open = model.open.filter((_, i) => i !== hit.topIndex);
	return { ok: true, model: { open, done: [doneItem, ...model.done] }, label: hit.label };
}

/** Changes any item's status (open or done) and optional ETA; moving a done top-level item off "done" reopens it at the end of the open list. */
export function setStatus(
	model: ChecklistModel,
	match: string,
	status: Status,
	eta?: EtaBucket,
): MutationResult | MatchFailure {
	const located = locateAll(model);
	const resolved = resolveOne(located, match);
	if (!resolved.ok) return resolved;
	const { hit } = resolved;
	const nextEta = status === "done" ? undefined : eta ?? hit.item.eta;

	if (hit.scope === "open-child" || hit.scope === "done-child") {
		const parentList = hit.scope === "open-child" ? model.open : model.done;
		const parent = parentList[hit.topIndex] as ChecklistItem;
		const children = parent.children.map((child) =>
			child === hit.item ? { ...child, status, eta: nextEta } : child,
		);
		const updatedParent = { ...parent, children };
		const open =
			hit.scope === "open-child"
				? model.open.map((item, i) => (i === hit.topIndex ? updatedParent : item))
				: model.open;
		const done =
			hit.scope === "done-child"
				? model.done.map((item, i) => (i === hit.topIndex ? updatedParent : item))
				: model.done;
		return { ok: true, model: { open, done }, label: hit.label };
	}

	const updatedItem: ChecklistItem = { ...hit.item, status, eta: nextEta };
	if (hit.scope === "open-top") {
		if (status === "done") {
			const open = model.open.filter((_, i) => i !== hit.topIndex);
			const done = [updatedItem, ...model.done];
			return { ok: true, model: { open, done }, label: hit.label };
		}
		const open = model.open.map((item, i) => (i === hit.topIndex ? updatedItem : item));
		return { ok: true, model: { open, done: model.done }, label: hit.label };
	}

	if (status === "done") {
		const done = model.done.map((item, i) => (i === hit.topIndex ? updatedItem : item));
		return { ok: true, model: { open: model.open, done }, label: hit.label };
	}
	const done = model.done.filter((_, i) => i !== hit.topIndex);
	const open = [...model.open, updatedItem];
	return { ok: true, model: { open, done }, label: hit.label };
}

export interface AddOptions {
	status?: Status;
	eta?: EtaBucket;
	at?: number;
	under?: string;
}

function clampPosition(at: number, length: number): number {
	return Math.min(Math.max(at - 1, 0), length);
}

function withLabel(model: ChecklistModel, item: ChecklistItem): MutationResult {
	const label = locateAll(model).find((entry) => entry.item === item)?.label ?? "";
	return { ok: true, model, label };
}

/** Appends a new open item; `under` places it as a sub-item of an open top-level item, `at` places it among top-level items. */
export function addItem(
	model: ChecklistModel,
	text: string,
	opts: AddOptions = {},
): MutationResult | MatchFailure | PlacementFailure {
	const item: ChecklistItem = {
		text: sanitizeText(text),
		status: opts.status ?? "queued",
		eta: opts.eta,
		children: [],
	};

	if (opts.under !== undefined) {
		const located = locateAll(model).filter((entry) => entry.scope === "open-top");
		const resolved = /^\d+$/.test(opts.under)
			? resolveByPosition(located, Number(opts.under))
			: resolveOne(located, opts.under);
		if (!resolved.ok) return resolved;
		const parentIndex = resolved.hit.topIndex;
		const parent = model.open[parentIndex] as ChecklistItem;
		const updatedParent = { ...parent, children: [...parent.children, item] };
		const open = model.open.map((entry, i) => (i === parentIndex ? updatedParent : entry));
		return withLabel({ open, done: model.done }, item);
	}

	const insertedAt = (storedPosition: number): ChecklistModel => ({
		open: [...model.open.slice(0, storedPosition), item, ...model.open.slice(storedPosition)],
		done: model.done,
	});
	if (opts.at === undefined) return withLabel(insertedAt(model.open.length), item);

	const wanted = clampPosition(opts.at, model.open.length);
	let best = { model: insertedAt(model.open.length), distance: Number.POSITIVE_INFINITY, shownAt: 0 };
	for (let stored = 0; stored <= model.open.length && best.distance > 0; stored++) {
		const candidate = insertedAt(stored);
		const shownAt = displayEntries(candidate).findIndex((entry) => entry.item === item);
		const distance = Math.abs(shownAt - wanted);
		if (distance < best.distance) best = { model: candidate, distance, shownAt };
	}
	if (best.distance > 0 && opts.at <= model.open.length) {
		return { ok: false, placement: { wanted: opts.at, landsAt: best.shownAt + 1 } };
	}
	return withLabel(best.model, item);
}
