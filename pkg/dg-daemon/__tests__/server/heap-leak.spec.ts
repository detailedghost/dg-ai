import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_JOBS_PATH, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	bootServe,
	cleanupDgHome,
	connectCli,
	connectPage,
	registerSession,
	send,
	sessionCredentials,
	stopServe,
	EXTENSION_ORIGIN,
} from "../utils/daemon-harness";
import { type HeapReading, measureSlope } from "../utils/heap-slope";

const PRELOAD = join(import.meta.dir, "../utils/heap-probe-preload.ts");
const BODY = "retained?".repeat(400);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function bootProbed() {
	const probeOut = join(process.env.TMPDIR ?? "/tmp", `dg-heap-${process.pid}-${Date.now()}.json`);
	const { dgHome, port, proc } = await bootServe({ DG_HEAP_PROBE_OUT: probeOut, BUN_OPTIONS: `--preload ${PRELOAD}` });
	cleanups.push(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
		rmSync(probeOut, { force: true });
	});
	const { daemonConfigPath } = resolveDgPaths({ env: { DG_HOME: dgHome } });
	mkdirSync(join(daemonConfigPath, ".."), { recursive: true });
	writeFileSync(daemonConfigPath, JSON.stringify({ jobs: { quick: { argv: ["/bin/echo", "hi"], cwd: dgHome, every: "1h", enabled: true } } }));
	const heap = async (): Promise<HeapReading> => {
		rmSync(probeOut, { force: true });
		process.kill(proc.pid, "SIGUSR2");
		for (let tries = 0; tries < 100; tries++) {
			await pause(50);
			try {
				return JSON.parse(readFileSync(probeOut, "utf8")) as HeapReading;
			} catch {}
		}
		throw new Error("the daemon never wrote a heap reading");
	};
	return { dgHome, port, heap };
}

describe("daemon heap stays flat under churn", () => {
	it("holds no per-request state across cli, page, message, and job traffic", async () => {
		const { dgHome, port, heap } = await bootProbed();
		const session = await registerSession(port);
		const credentials = { sessionId: session.sessionId, token: session.token };
		let page: WebSocket | undefined;
		let cli: WebSocket | undefined;
		const phases: Record<string, { iterations: number; step: () => Promise<void> }> = {
			"cli-recv connect and close": {
				iterations: 300,
				step: async () => {
					const socket = await connectCli(port, await sessionCredentials(dgHome, session.sessionId));
					send(socket, { type: "cli-recv", block: false });
					await pause(2);
					socket.close();
				},
			},
			"blocked cli-recv closed by the client": {
				iterations: 200,
				step: async () => {
					const socket = await connectCli(port, await sessionCredentials(dgHome, session.sessionId));
					send(socket, { type: "cli-recv", block: true, timeoutMs: 30_000 });
					await pause(5);
					socket.close();
				},
			},
			"user message from a page": {
				iterations: 300,
				step: async () => {
					page ??= await connectPage(port, credentials);
					page.send(JSON.stringify({ type: "user-message", ...credentials, protocolVersion: CHAT_PROTOCOL_VERSION, messageId: crypto.randomUUID(), body: BODY }));
					await pause(2);
				},
			},
			"cli-send": {
				iterations: 300,
				step: async () => {
					cli ??= await connectCli(port, await sessionCredentials(dgHome, session.sessionId));
					send(cli, { type: "cli-send", body: BODY });
					await pause(2);
				},
			},
			"scheduled job run": {
				iterations: 100,
				step: async () => {
					for (;;) {
						const response = await fetch(`http://127.0.0.1:${port}${CHAT_JOBS_PATH}/quick/start`, {
							method: "POST",
							headers: { Host: `127.0.0.1:${port}`, Origin: EXTENSION_ORIGIN },
						});
						await response.text();
						if (response.status === 200) break;
						await pause(3);
					}
					await pause(15);
				},
			},
		};
		const report: string[] = [];
		const leaking: string[] = [];
		for (const [name, { iterations, step }] of Object.entries(phases)) {
			const run = await measureSlope(step, heap, { warmup: 30, batches: 4, iterations });
			report.push(`${name}: ${run.slopes.join(", ")} bytes per iteration`);
			if (run.leaking) leaking.push(name);
		}
		page?.close();
		cli?.close();
		console.log(report.join("\n"));
		expect(leaking).toEqual([]);
	}, 120_000);
});
