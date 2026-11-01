import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { Command } from "commander";
import { registerHooks } from "../../src/commands/hooks";
import { main } from "../../src/hooks/cli";
import { HOOKS } from "../../src/hooks/manifest";
import type { HookSeams } from "../../src/hooks/types";
import { editInput, hookWorld } from "./hook-fixtures";

let world: ReturnType<typeof hookWorld>;
beforeEach(() => {
	world = hookWorld();
});
afterEach(() => world.cleanup());

function io(input: unknown) {
	const out = { stdout: "", stderr: "" };
	const seams: HookSeams = {
		run: async () => ({ status: 0, stdout: "", stderr: "" }),
		which: () => undefined,
		spawnDetached: () => {},
		stdout: (t) => {
			out.stdout += t;
		},
		stderr: (t) => {
			out.stderr += t;
		},
	};
	return {
		out,
		io: {
			stdin: Readable.from([JSON.stringify(input)]),
			env: world.env(),
			seams,
		},
	};
}

describe("hooks command", () => {
	test("registers a raw hooks command on the program", () => {
		const program = new Command().enablePositionalOptions();
		registerHooks(program);
		expect(program.commands.map((c) => c.name())).toContain("hooks");
	});

	test("hooks run <id> reaches runHook", async () => {
		const { io: harness, out } = io(editInput("const colour = 1;"));
		const code = await main(["run", "spelling"], harness);
		expect(code).toBe(2);
		expect(out.stderr).toContain("colour -> color");
	});

	test("hooks run with an unknown id exits 1", async () => {
		const { io: harness, out } = io({});
		expect(await main(["run", "nope"], harness)).toBe(1);
		expect(out.stderr).toContain("unknown hook");
	});

	test("a missing subcommand prints usage and exits 2", async () => {
		const { io: harness, out } = io({});
		expect(await main([], harness)).toBe(2);
		expect(out.stderr).toContain("usage");
	});

	test("the manifest holds the six hooks with unique ids", () => {
		expect(HOOKS.map((h) => h.id).sort()).toEqual([
			"daily-prune",
			"format",
			"pr-confirm",
			"pr-prose",
			"spec-plan-lint",
			"spelling",
		]);
	});

	test("passes an event for an unrelated tool", async () => {
		const { io: harness } = io({ tool_name: "Read" });
		expect(await main(["run", "spelling"], harness)).toBe(0);
	});

	test("registers one hooks command that owns every argument", () => {
		const program = new Command().enablePositionalOptions();
		registerHooks(program);
		const hooks = program.commands.filter((c) => c.name() === "hooks");
		expect(hooks).toHaveLength(1);
		expect(hooks[0]?.description()).toBe("Run and manage the opt-in hooks");
	});

	test("the registered action exits the process with the main result", async () => {
		const exit = spyOn(process, "exit").mockImplementation(
			(() => undefined) as never,
		);
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			const program = new Command().enablePositionalOptions();
			registerHooks(program);
			await program.parseAsync(["hooks", "run", "no-such-hook"], {
				from: "user",
			});
			expect(exit).toHaveBeenCalledWith(1);
			expect(String(stderr.mock.calls[0]?.[0])).toContain("unknown hook");
		} finally {
			exit.mockRestore();
			stderr.mockRestore();
		}
	});

	test("the registered action exits 2 with usage when no subcommand follows", async () => {
		const exit = spyOn(process, "exit").mockImplementation(
			(() => undefined) as never,
		);
		const stderr = spyOn(process.stderr, "write").mockImplementation(
			() => true,
		);
		try {
			const program = new Command().enablePositionalOptions();
			registerHooks(program);
			await program.parseAsync(["hooks"], { from: "user" });
			expect(exit).toHaveBeenCalledWith(2);
			expect(String(stderr.mock.calls[0]?.[0])).toContain("usage");
		} finally {
			exit.mockRestore();
			stderr.mockRestore();
		}
	});
});
