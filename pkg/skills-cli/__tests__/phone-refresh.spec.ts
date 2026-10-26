import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshPhoneListener } from "../src/commands/phone-listener";

const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("refreshPhoneListener", () => {
	it("asks the installed dg-agent to refresh when the binary is on disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-phone-refresh-"));
		homes.push(dir);
		const agent = join(dir, "dg-agent");
		writeFileSync(agent, "");
		const calls: { command: string; args: readonly string[]; timeout: number }[] = [];

		refreshPhoneListener(agent, ((command: string, args: readonly string[], options: { timeout?: number }) => {
			calls.push({ command, args, timeout: options.timeout ?? 0 });
			return {} as ReturnType<typeof spawnSync>;
		}) as typeof spawnSync);

		expect(calls).toEqual([{ command: agent, args: ["phone", "__refresh"], timeout: 8_000 }]);
	});

	it("does not spawn when the dg-agent binary is absent", () => {
		let called = false;
		refreshPhoneListener(join(tmpdir(), "dg-phone-refresh-missing", "dg-agent"), (() => {
			called = true;
			return {} as ReturnType<typeof spawnSync>;
		}) as typeof spawnSync);

		expect(called).toBe(false);
	});

	it("warns with the refresh's stderr when it exits non-zero, and stays quiet on success", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-phone-refresh-"));
		homes.push(dir);
		const agent = join(dir, "dg-agent");
		writeFileSync(agent, "");
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const refusal =
			'line "default" has no key to migrate; refusing to mint a new number. Restore the nsec in that line\'s database or the credential phone-friend/default/nostr-key, then run phone open';
		try {
			refreshPhoneListener(agent, (() => ({ status: 0, stderr: "migrated\n" }) as ReturnType<typeof spawnSync>) as typeof spawnSync);
			expect(warn).not.toHaveBeenCalled();

			refreshPhoneListener(
				agent,
				(() => ({ status: 1, stderr: `noise\ndg-agent: ${refusal}\n` }) as ReturnType<typeof spawnSync>) as typeof spawnSync,
			);
			expect(warn).toHaveBeenCalledWith(`warning: phone listener was not refreshed: dg-agent: ${refusal}`);
		} finally {
			warn.mockRestore();
		}
	});
});
