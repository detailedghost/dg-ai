import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

	it("repairs a permissive DG_HOME before writing the pairing record", async () => {
		const dgHome = freshDgHome();
		try {
			chmodSync(dgHome, 0o777);

			const result = await runDaemonCommand(dgHome, "pair");

			expect(result.exitCode).toBe(0);
			expect(statSync(dgHome).mode & 0o777).toBe(0o700);
		} finally {
			cleanupDgHome(dgHome);
		}
	});

	it("waits for the cross-process pairing lock before replacing the record", async () => {
		const dgHome = freshDgHome();
		try {
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const lockPath = `${paths.pairingPath}.lock`;
			mkdirSync(lockPath, { mode: 0o700 });
			writeFileSync(join(lockPath, "owner"), String(process.pid), {
				mode: 0o600,
			});
			let settled = false;
			const command = runDaemonCommand(dgHome, "pair").then((result) => {
				settled = true;
				return result;
			});

			await Bun.sleep(50);

			expect(settled).toBe(false);
			expect(statSync(lockPath).isDirectory()).toBe(true);
			rmSync(lockPath, { force: true, recursive: true });
			const result = await command;
			expect(result.exitCode).toBe(0);
			expect(readFileSync(paths.pairingPath, "utf8")).not.toBe("");
		} finally {
			cleanupDgHome(dgHome);
		}
	});
});
