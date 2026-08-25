import { join } from "node:path";
import { subprocessEnv } from "@dg/dg-daemon/test-harness";
import type { Subprocess } from "bun";

export const ENTRY = join(import.meta.dir, "../src/index.ts");

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

export async function runCli(
	dgHome: string,
	port: number,
	args: string[],
	extraEnv: Record<string, string> = {},
	opts: { cwd?: string; stdin?: Uint8Array } = {},
): Promise<CliRunResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
		env: subprocessEnv(dgHome, port, extraEnv),
		cwd: opts.cwd,
		...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
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
