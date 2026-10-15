import type { runCapture } from "@dg/common/node";
import { CLI_TIMEOUT_MS } from "../runners/probe";
import type { CrCode } from "../errors";
import { VerdictError } from "./types";

export type CaptureFn = typeof runCapture;
type Captured = Awaited<ReturnType<CaptureFn>>;

const LOGIN_FAILURE = /\b401\b|unauthori|not logged in|bad credentials/i;
const NOT_VISIBLE = /\b(404|403)\b/;
const MAX_PAGES = 50;
export const PAGE_SIZE = 100;
const GH_AUTH_EXIT = 4;

export type Cli = { command: "gh" | "glab"; hostFlag: string };

export function failureCode(
	command: Cli["command"],
	result: Captured,
): Extract<CrCode, "CR-302" | "CR-303"> | undefined {
	if (command === "gh" && result.status === GH_AUTH_EXIT) return "CR-303";
	if (LOGIN_FAILURE.test(result.stderr)) return "CR-303";
	if (NOT_VISIBLE.test(result.stderr)) return "CR-302";
	return undefined;
}

export async function capture(
	runner: CaptureFn,
	command: string,
	args: string[],
): Promise<Captured> {
	try {
		return await runner(command, args, { timeoutMs: CLI_TIMEOUT_MS });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new VerdictError("CR-303", `${command} is not installed`);
		}
		throw error;
	}
}

export async function apiJson(
	runner: CaptureFn,
	command: Cli["command"],
	host: string,
	endpoint: string,
	extra: string[] = [],
): Promise<unknown> {
	const result = await capture(runner, command, [
		"api",
		"--hostname",
		host,
		...extra,
		endpoint,
	]);
	if (result.status !== 0) {
		const code = failureCode(command, result);
		if (code) throw new VerdictError(code, result.stderr.trim());
		throw new Error(`${command} api failed (${result.status}): ${result.stderr.trim()}`);
	}
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`${command} api returned malformed JSON`);
	}
}

export async function pagedJson<T>(
	fetchPage: (page: number) => Promise<unknown>,
): Promise<T[]> {
	const all: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const rows = await fetchPage(page);
		if (!Array.isArray(rows)) throw new Error("expected a JSON array page");
		all.push(...(rows as T[]));
		if (rows.length < PAGE_SIZE) break;
	}
	return all;
}

export function flattenSlurp<T>(value: unknown): T[] {
	if (!Array.isArray(value)) throw new Error("expected a slurped JSON array");
	return value.flat() as T[];
}

const VERDICT_HEADING = "## Thrash review";
const LABELS = [
	{ pattern: /\*\*Verdict:\*\*\s*Approve\b/i, verdict: "approved" },
	{ pattern: /\*\*Verdict:\*\*\s*Request changes\b/i, verdict: "changes_requested" },
] as const;

export function isThrashSummary(body: string): boolean {
	return body.startsWith(VERDICT_HEADING);
}

export function verdictFromLabel(body: string): "approved" | "changes_requested" | "commented" {
	return LABELS.find(({ pattern }) => pattern.test(body))?.verdict ?? "commented";
}

export const CLOCK_SLACK_MS = 2 * 60_000;
