import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type PrototypeDirOptions,
	decisionPath,
	notesPath,
	rejectPath,
	selectionPath,
} from "./paths";

function isMissingFile(error: unknown): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error as NodeJS.ErrnoException).code === "ENOENT"
	);
}

async function readIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return undefined;
		throw error;
	}
}

async function removeQuietly(path: string): Promise<void> {
	await rm(path, { force: true });
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

const POLL_INTERVAL_MS = 300;

export type SelectionResult =
	| { status: "ok"; variant: string; notes: string }
	| { status: "rejected"; notes: string }
	| { status: "timeout" };

export interface WaitOptions extends PrototypeDirOptions {
	timeoutMs: number;
}

/** Block until a `.selection` or `.reject` sentinel appears, consuming it; times out after `timeoutMs`. */
export async function waitForSelection(
	name: string,
	opts: WaitOptions,
): Promise<SelectionResult> {
	const [sentinel, reject, notes] = await Promise.all([
		selectionPath(name, opts),
		rejectPath(name, opts),
		notesPath(name, opts),
	]);
	const deadline = Date.now() + opts.timeoutMs;

	while (true) {
		const selected = await readIfExists(sentinel);
		if (selected !== undefined) {
			const variant = selected.split("\n")[0]?.trim() ?? "";
			const noteText = (await readIfExists(notes)) ?? "";
			await Promise.all([removeQuietly(sentinel), removeQuietly(notes)]);
			return { status: "ok", variant, notes: noteText };
		}
		const rejected = await readIfExists(reject);
		if (rejected !== undefined) {
			await Promise.all([removeQuietly(reject), removeQuietly(notes)]);
			return { status: "rejected", notes: rejected };
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { status: "timeout" };
		await sleep(Math.min(POLL_INTERVAL_MS, remaining));
	}
}

/** Non-consuming read of the current selection state: a variant key, "rejected", or "pending". */
export async function selectionStatus(
	name: string,
	opts: PrototypeDirOptions = {},
): Promise<string> {
	const [sentinel, reject] = await Promise.all([
		selectionPath(name, opts),
		rejectPath(name, opts),
	]);
	const selected = await readIfExists(sentinel);
	if (selected !== undefined) return selected.trim();
	const rejected = await readIfExists(reject);
	if (rejected !== undefined) return "rejected";
	return "pending";
}

/** Write a `.selection` sentinel (plus optional `.notes`), matching the legacy manual-confirm ordering. */
export async function confirmSelection(
	name: string,
	variant: string,
	opts: PrototypeDirOptions & { notes?: string } = {},
): Promise<void> {
	const sentinel = await selectionPath(name, opts);
	await mkdir(dirname(sentinel), { recursive: true });
	// Notes land before the trigger file: .selection is what `waitForSelection`
	// wakes on, so its sidecar must already be on disk or the notes are lost.
	if (opts.notes) {
		await writeFile(await notesPath(name, opts), opts.notes);
	}
	await writeFile(sentinel, `${variant}\n`);
}

export type DecisionResult =
	| { status: "ok"; raw: string; decision: string }
	| { status: "timeout" };

const DECISION_FIELD = /"decision":"([^"]*)"/;

function extractDecision(raw: string): string {
	const match = DECISION_FIELD.exec(raw);
	return match ? match[1] : raw;
}

/** Block until a `.decision` sentinel appears, consuming it; times out after `timeoutMs`. */
export async function waitForDecision(
	name: string,
	opts: WaitOptions,
): Promise<DecisionResult> {
	const path = await decisionPath(name, opts);
	const deadline = Date.now() + opts.timeoutMs;

	while (true) {
		const raw = await readIfExists(path);
		if (raw !== undefined) {
			await removeQuietly(path);
			return { status: "ok", raw, decision: extractDecision(raw) };
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { status: "timeout" };
		await sleep(Math.min(POLL_INTERVAL_MS, remaining));
	}
}
