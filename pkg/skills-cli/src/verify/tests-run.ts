import { spawn } from "node:child_process";
import type { VerifyTests } from "./manifest";

export interface TestReport {
	status: "passed" | "failed" | "not-run";
	summary: string;
	exitCode: number | null;
}

const OUTPUT_MAX = 4000;

/** Require a bare executable name and single-line arguments. The runner passes the argv to spawn, never to a shell. */
export function assertArgv(cmd: readonly string[]): void {
	if (cmd.length === 0) throw new Error("test command is empty");
	const [bin] = cmd;
	if (!bin || bin.includes("/") || bin.includes("\\") || bin.includes(".."))
		throw new Error("test command must be a bare executable name");
	for (const arg of cmd) {
		if (arg.includes("\0") || arg.includes("\n") || arg.includes("\r"))
			throw new Error("test command arguments must be a single line");
	}
}

function supplied(tests: VerifyTests): TestReport {
	const failed = tests.failed ?? 0;
	const summary = tests.summary ?? "No test results supplied.";
	if (!tests.summary) return { status: "not-run", summary, exitCode: null };
	return {
		status: failed > 0 ? "failed" : "passed",
		summary,
		exitCode: failed > 0 ? 1 : 0,
	};
}

/** Run a declared argv, or record the summary the agent already collected. */
export async function runDeclaredTests(
	tests: VerifyTests | undefined,
	cwd: string,
	timeoutMs = 15_000,
): Promise<TestReport> {
	if (!tests) return { status: "not-run", summary: "No test results supplied.", exitCode: null };
	if (!tests.cmd || tests.cmd.length === 0) return supplied(tests);
	assertArgv(tests.cmd);
	const child = spawn(tests.cmd[0] as string, tests.cmd.slice(1), {
		cwd,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	const keep = (chunk: Buffer) => {
		out += chunk.toString();
		if (out.length > OUTPUT_MAX * 4) out = out.slice(-OUTPUT_MAX * 2);
	};
	child.stdout?.on("data", keep);
	child.stderr?.on("data", keep);
	const code = await new Promise<number | null>((resolve) => {
		let settled = false;
		const finish = (status: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(status);
		};
		const timer = setTimeout(() => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			child.stdout?.destroy();
			child.stderr?.destroy();
			finish(null);
		}, timeoutMs);
		child.on("error", () => finish(null));
		child.on("close", finish);
	});
	const clipped = out.trim().slice(-OUTPUT_MAX);
	const summary = clipped.length > 0 ? clipped : (tests.summary ?? `exit ${code ?? "missing"}`);
	return {
		status: code === 0 ? "passed" : "failed",
		summary,
		exitCode: code,
	};
}
