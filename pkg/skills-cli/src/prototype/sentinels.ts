import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "@dg/common/node";
import type { SentinelPaths } from "./paths";

export type WaitResult =
	| { status: "ok"; variant: string; notes: string }
	| { status: "rejected"; notes: string }
	| { status: "timeout" };

export type DecisionResult =
	| { status: "ok"; contents: string; decision: string }
	| { status: "timeout" };

const POLL_MS = 200;

function readTrimmed(path: string): string {
	return readFileSync(path, "utf8").replace(/\n+$/, "");
}

export function writeSentinel(path: string, contents: string): void {
	writeFileAtomic(path, contents);
}

/** Remove consumed sentinel files; a failed removal warns on stderr instead of failing the claim. */
export function removeSentinels(...paths: string[]): void {
	let failed = false;
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			rmSync(path, { force: true });
		} catch {
			failed = true;
		}
	}
	if (failed)
		process.stderr.write(
			"prototype: warning: could not remove consumed sentinel file(s); rerun with sufficient permissions to clear stale state\n",
		);
}

function claim(paths: SentinelPaths): WaitResult | undefined {
	try {
		return claimExisting(paths);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function claimExisting(paths: SentinelPaths): WaitResult | undefined {
	if (existsSync(paths.selection)) {
		const variant = (
			readFileSync(paths.selection, "utf8").split("\n")[0] ?? ""
		).replace(/[\r\s]/g, "");
		const notes = existsSync(paths.notes) ? readTrimmed(paths.notes) : "";
		removeSentinels(paths.selection, paths.notes);
		return { status: "ok", variant, notes };
	}
	if (existsSync(paths.reject)) {
		const notes = readTrimmed(paths.reject);
		removeSentinels(paths.reject, paths.notes);
		return { status: "rejected", notes };
	}
	return undefined;
}

async function poll<T>(
	timeoutSec: number,
	attempt: () => T | undefined,
): Promise<T | undefined> {
	const deadline = Date.now() + timeoutSec * 1000;
	while (true) {
		const found = attempt();
		if (found !== undefined) return found;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		await Bun.sleep(Math.min(POLL_MS, remaining));
	}
}

/** Record a variant selection, with optional notes, exactly as the served page would. */
export function confirm(
	paths: SentinelPaths,
	variant: string,
	notes = "",
): void {
	mkdirSync(paths.dir, { recursive: true });
	if (notes) writeSentinel(paths.notes, notes);
	writeSentinel(paths.selection, `${variant}\n`);
}

/** Report the selected variant, "rejected", or "pending" without consuming anything. */
export function status(paths: SentinelPaths): string {
	if (existsSync(paths.selection))
		return readFileSync(paths.selection, "utf8").replace(/[\r\n\s]/g, "");
	if (existsSync(paths.reject)) return "rejected";
	return "pending";
}

/** Block until a selection or rejection exists, consume it, and report it; the sentinels are checked before any wait. */
export async function wait(
	paths: SentinelPaths,
	timeoutSec: number,
): Promise<WaitResult> {
	return (await poll(timeoutSec, () => claim(paths))) ?? { status: "timeout" };
}

/** Block until a plan-walkthrough decision file exists, consume it, and report it. */
export async function awaitDecision(
	paths: SentinelPaths,
	timeoutSec: number,
): Promise<DecisionResult> {
	const found = await poll(timeoutSec, () => {
		if (!existsSync(paths.decision)) return undefined;
		const contents = readTrimmed(paths.decision);
		removeSentinels(paths.decision);
		return contents;
	});
	if (found === undefined) return { status: "timeout" };
	let decision = "";
	try {
		const parsed: unknown = JSON.parse(found);
		if (parsed && typeof parsed === "object" && "decision" in parsed)
			decision = String(parsed.decision);
	} catch {
		decision = "";
	}
	return { status: "ok", contents: found, decision };
}

export function formatWait(result: WaitResult, json: boolean): string {
	if (json) return `${JSON.stringify(result)}\n`;
	if (result.status === "timeout") return "timeout\n";
	const head = result.status === "ok" ? result.variant : "rejected";
	return result.notes ? `${head}\n${result.notes}\n` : `${head}\n`;
}

export function formatDecision(result: DecisionResult, json: boolean): string {
	if (result.status === "timeout")
		return json ? `${JSON.stringify(result)}\n` : "timeout\n";
	return json ? `${result.contents}\n` : `${result.decision}\n`;
}
