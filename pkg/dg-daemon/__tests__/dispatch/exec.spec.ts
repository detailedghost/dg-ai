import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "../../src/dispatch/exec";
import { freshTempDir, removeScratchDirs } from "../utils/daemon-harness";

afterEach(removeScratchDirs);

function writeScript(body: string): string {
	const dir = freshTempDir("dg-exec");
	const path = join(dir, "script.sh");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

describe("executeCommand", () => {
	it("returns within a bound when a detached grandchild keeps holding the output pipe open past the kill", async () => {
		const scriptPath = writeScript(
			[
				"setsid sh -c 'exec sleep 30' >&1 2>&1 &",
				"echo hello-before-timeout",
				"while true; do sleep 0.2; done",
			].join("\n"),
		);

		const startedAt = Date.now();
		const result = await executeCommand([scriptPath], tmpdir(), {
			timeoutMs: 200,
			maxOutputBytes: 262_144,
		});
		const elapsedMs = Date.now() - startedAt;

		expect(elapsedMs).toBeLessThan(4000);
		expect(result.exitOk).toBe(false);
		expect(result.failureReason ?? "").toMatch(/timed out/i);
		expect(result.stdout).toContain("hello-before-timeout");
	}, 10_000);

	it("kills the process tree immediately on win32 when the timeout fires", async () => {
		const execs: Array<[string, string[]]> = [];
		const scriptPath = writeScript("while true; do sleep 0.2; done");
		let pid = 0;
		const result = await executeCommand(
			[scriptPath],
			tmpdir(),
			{ timeoutMs: 200, maxOutputBytes: 262_144 },
			{
				platform: "win32",
				exec: (command, args) => {
					execs.push([command, args]);
					pid = Number(args.at(-1));
					process.kill(-pid, "SIGKILL");
				},
			},
		);

		expect(execs).toEqual([["taskkill", ["/T", "/F", "/PID", String(pid)]]]);
		expect(result.failureReason ?? "").toMatch(/timed out/i);
	}, 10_000);

	it("kills the process tree immediately on win32 when the output cap is hit", async () => {
		const execs: Array<[string, string[]]> = [];
		const scriptPath = writeScript(
			"while true; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; sleep 0.05; done",
		);
		const result = await executeCommand(
			[scriptPath],
			tmpdir(),
			{ timeoutMs: 5000, maxOutputBytes: 100 },
			{
				platform: "win32",
				exec: (command, args) => {
					execs.push([command, args]);
					process.kill(-Number(args.at(-1)), "SIGKILL");
				},
			},
		);

		expect(execs).toHaveLength(1);
		expect(execs[0]?.[0]).toBe("taskkill");
		expect(result.truncated).toBe(true);
	}, 10_000);
});
