// Thin process-launch primitive for /proxy backends. Spawns the backend
// binary, captures its full output, and reports exactly what happened —
// success/failure classification belongs to the caller (cli.ts), not here.

import { randomUUID } from "node:crypto";
import { scratchDir } from "@dg/common/node";
import type { Backend, BuildArgsInput } from "./backends/types";

const STDERR_TAIL_LENGTH = 2000;

export function proxyDir(): string {
	return scratchDir("proxy", { cwdScope: false });
}

export async function runBackend(
	backendName: string,
	backend: Backend,
	input: BuildArgsInput & { cwd?: string },
): Promise<{
	exitCode: number;
	sessionId: string | null;
	message: string;
	stderrTail: string;
	logFile: string;
}> {
	const args = backend.buildArgs(input);
	const proc = Bun.spawn([backend.bin, ...args], {
		cwd: input.cwd ?? process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});

	// Stream stdout to the log file as chunks arrive so the run is observable live
	// (`tail -f <logFile>`) instead of only after exit; announce the path on stderr.
	const logFile = `${proxyDir()}/${Date.now()}-${randomUUID()}-${backendName}.jsonl`;
	console.error(`proxy: streaming ${backendName} output -> ${logFile} (tail -f to watch)`);
	const logSink = Bun.file(logFile).writer();

	const decoder = new TextDecoder();
	let stdout = "";
	const pumpStdout = (async () => {
		for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
			stdout += decoder.decode(chunk, { stream: true });
			logSink.write(chunk);
			await logSink.flush();
		}
		stdout += decoder.decode();
	})();

	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	await pumpStdout;
	await logSink.end();

	const { sessionId, message } = backend.parseEvents(stdout);
	const stderrTail = stderr.trim().slice(-STDERR_TAIL_LENGTH);

	return { exitCode, sessionId, message, stderrTail, logFile };
}
