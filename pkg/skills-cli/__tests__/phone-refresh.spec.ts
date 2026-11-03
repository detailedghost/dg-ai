import { describe, expect, it, spyOn } from "bun:test";
import { spawnSync } from "node:child_process";
import { programCommand, setProgramName } from "@dg/common/node/program";
import { refreshPhoneListener } from "../src/install/phone-listener";

describe("refreshPhoneListener", () => {
	it("warns with the refresh's stderr when it exits non-zero, and stays quiet on success", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const refusal =
			'line "default" has no key to migrate; refusing to mint a new number. Restore the nsec in that line\'s database or the credential phone-friend/default/nostr-key, then run phone open';
		try {
			refreshPhoneListener((() => ({ status: 0, stderr: "migrated\n" }) as ReturnType<typeof spawnSync>) as typeof spawnSync);
			expect(warn).not.toHaveBeenCalled();

			refreshPhoneListener(
				(() => ({ status: 1, stderr: `noise\ndg-agent: ${refusal}\n` }) as ReturnType<typeof spawnSync>) as typeof spawnSync,
			);
			expect(warn).toHaveBeenCalledWith(`warning: phone listener was not refreshed: dg-agent: ${refusal}`);
		} finally {
			warn.mockRestore();
		}
	});

	it("warns instead of throwing when the spawn itself fails", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			refreshPhoneListener((() => ({ error: new Error("spawn ENOENT") }) as ReturnType<typeof spawnSync>) as typeof spawnSync);
			expect(warn).toHaveBeenCalledWith("warning: phone listener was not refreshed: spawn ENOENT");
		} finally {
			warn.mockRestore();
		}
	});
});

describe("refreshPhoneListener argv", () => {
	it("spawns programCommand(dg-agent, [phone, __refresh]) and never the cmd shim", () => {
		setProgramName("dg-agent");
		try {
			const [command, ...args] = programCommand("dg-agent", ["phone", "__refresh"]);
			const calls: { command: string; args: readonly string[]; timeout: number }[] = [];

			refreshPhoneListener(((cmd: string, argv: readonly string[], options: { timeout?: number }) => {
				calls.push({ command: cmd, args: argv, timeout: options.timeout ?? 0 });
				return {} as ReturnType<typeof spawnSync>;
			}) as typeof spawnSync);

			expect(calls).toEqual([{ command, args, timeout: 8_000 }]);
			expect(calls[0].command.endsWith(".cmd")).toBe(false);
			expect(calls[0].args.slice(-3)).toEqual(["dg-agent", "phone", "__refresh"]);
		} finally {
			setProgramName(undefined);
		}
	});
});
