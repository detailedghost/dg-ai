/**
 * Slice 7's own test helper, sibling to (and reusing) __tests__/utils/daemon-harness.ts
 * rather than a second copy of its subprocess/socket plumbing.
 *
 * [SPEC] ASSUMED wire addendum — plan.md pins recv/send/progress/manifest
 * BEHAVIOR but names no wire shape for any of them, and none of the 18
 * ratified ChatFrame discriminants covers "claim the next stored message"
 * or "publish this manifest from a /cli connection with no per-frame token".
 * This file's shapes are this pass's proposal, structurally checked
 * OUTSIDE validateChatFrame — exactly like the existing "connect" handshake
 * carve-out on /ws (daemon-harness.ts's sendConnectHandshake). See deferrals
 * for the full rationale and the recommended alternative.
 *
 * spawn and close need NONE of this: a /cli connection already holds its
 * own sessionId+token capability from the upgrade headers, so it can send
 * the ordinary ratified `session-create` / `session-close` ChatFrame types
 * (with that token) through the ratified path unchanged.
 */
import { join } from "node:path";
import type { ProgressState } from "@dg/common";
import type { Subprocess } from "bun";
import { ENTRY, subprocessEnv } from "../utils/daemon-harness";

export type CliRecvRequest = {
	type: "cli-recv";
	block: boolean;
	timeoutMs?: number;
};
export type CliRecvResult =
	| {
			type: "cli-recv-result";
			outcome: "delivered";
			message: Record<string, unknown>;
	  }
	| { type: "cli-recv-result"; outcome: "empty" | "timeout" | "closed" };
export type CliAckRequest = { type: "cli-ack"; claimId: string };
export type CliSendRequest = { type: "cli-send"; body: string };
export type CliProgressRequest = { type: "cli-progress"; state: ProgressState };

export function nextParsedMessage(
	ws: WebSocket,
	timeoutMs = 3000,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(
			() => reject(new Error("no message received in time")),
			timeoutMs,
		);
		ws.addEventListener(
			"message",
			(ev) => {
				clearTimeout(t);
				try {
					resolve(JSON.parse(ev.data as string));
				} catch (err) {
					reject(err);
				}
			},
			{ once: true },
		);
	});
}

export type CliRunResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
};

/**
 * Spawn one of slice 7's CLI verbs against a DG_HOME/DG_PORT pair, awaited
 * to completion. Mirrors daemon-harness.ts's runStart/runStatus shape.
 */
export async function runCli(
	dgHome: string,
	port: number,
	args: string[],
	extraEnv: Record<string, string> = {},
	opts: { cwd?: string } = {},
): Promise<CliRunResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
		env: subprocessEnv(dgHome, port, extraEnv),
		cwd: opts.cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

/** Same as runCli but returns the live Subprocess unawaited — for a `recv --block` left parked. */
export function spawnCli(
	dgHome: string,
	port: number,
	args: string[],
	extraEnv: Record<string, string> = {},
): Subprocess<"ignore", "pipe", "pipe"> {
	return Bun.spawn([process.execPath, ENTRY, ...args], {
		env: subprocessEnv(dgHome, port, extraEnv),
		stdout: "pipe",
		stderr: "pipe",
	});
}

export function joinScratch(dir: string, ...parts: string[]): string {
	return join(dir, ...parts);
}
