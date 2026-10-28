import { spawn } from "node:child_process";
import type { VerifyTests } from "./manifest";

export interface TestReport {
	status: "passed" | "failed" | "not-run";
	summary: string;
	exitCode: number | null;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "cmd", "powershell", "pwsh"]);
const OUTPUT_MAX = 4000;

/** Reject a shell and any argv that is not a single line. The runner never uses a shell. */
export function assertArgv(cmd: readonly string[]): void {
	if (cmd.length === 0) throw new Error("test command is empty");
	const [bin] = cmd;
	if (!bin || bin.includes("/") || bin.includes("\\") || bin.includes(".."))
		throw new Error("test command must be a bare executable name");
	if (SHELLS.has(bin)) throw new Error("test command must not be a shell");
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
		stdio: ["ignore", "pipe", "pipe"],
	});
	let out = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	const code = await new Promise<number | null>((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("error", () => {
			clearTimeout(timer);
			resolve(null);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve(status);
		});
	});
	const clipped = out.trim().slice(0, OUTPUT_MAX);
	const summary = clipped.length > 0 ? clipped : (tests.summary ?? `exit ${code ?? "missing"}`);
	return {
		status: code === 0 ? "passed" : "failed",
		summary,
		exitCode: code,
	};
}
