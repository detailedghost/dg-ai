import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommand } from "../../src/dispatch/exec";

function writeScript(body: string): string {
	const dir = mkdtempSync(`${tmpdir()}/dg-exec-`);
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
});
