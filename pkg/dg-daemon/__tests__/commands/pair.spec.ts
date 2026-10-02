import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node";
import {
	cleanupDgHome,
	freshDgHome,
	runDaemonCommand,
} from "../utils/daemon-harness";

function extractCode(stdout: string): string {
	const match = stdout.match(/Pairing code: (\d{6})/);
	if (!match) throw new Error(`pairing code missing from output: ${stdout}`);
	return match[1];
}

describe("dg-daemon pair", () => {
	it("prints a pairing code and securely replaces the pairing record without a running daemon", async () => {
		const dgHome = freshDgHome();
		try {
			const before = Date.now();
			const first = await runDaemonCommand(dgHome, "pair");
			const code = extractCode(first.stdout);
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const firstRecord = JSON.parse(readFileSync(paths.pairingPath, "utf8"));

			expect(first.exitCode).toBe(0);
			expect(first.stderr).toBe("");
			expect(first.stdout).toContain("Expires at: ");
			expect(first.stdout).toContain(
				"Enter this code in the dg extension: Pair",
			);
			expect(firstRecord).toEqual({
				hash: createHash("sha256")
					.update(`${firstRecord.salt}${code}`)
					.digest("hex"),
				salt: firstRecord.salt,
				expiresAt: firstRecord.expiresAt,
				attemptsLeft: 5,
			});
			expect(firstRecord.expiresAt).toBeGreaterThanOrEqual(before + 299_000);
			expect(firstRecord.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
			expect(statSync(paths.pairingPath).mode & 0o777).toBe(0o600);
			expect(readFileSync(paths.pairingPath, "utf8")).not.toContain(code);

			const second = await runDaemonCommand(dgHome, "pair");
			const secondRecord = JSON.parse(
				readFileSync(paths.pairingPath, "utf8"),
			);
			expect(second.exitCode).toBe(0);
			expect(secondRecord.salt).not.toBe(firstRecord.salt);
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
