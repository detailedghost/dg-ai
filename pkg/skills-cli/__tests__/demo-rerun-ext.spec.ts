import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Command } from "commander";
import { registerDemo } from "../src/commands/demo";
import { registerRerun } from "../src/commands/rerun";
import { guardExtensionCommands, setCliOnly } from "../src/utils/cli-only";
import type { TourScript } from "../src/utils/plan-format";
import { type DemoWorld, demoWorld } from "./demo-local-fixtures";

type Played = { script: TourScript; ext?: boolean };

let world: DemoWorld;

beforeEach(() => {
	world = demoWorld();
});
afterEach(() => world.cleanup());

function deps(played: Played[] = [], verified: boolean[] = []) {
	return {
		play: async (script: TourScript, opts: { ext?: boolean }) =>
			void played.push({ script, ext: opts.ext }),
		local: world.localDeps(),
		verify: async (_script: TourScript, opts: { ext: boolean }) => {
			verified.push(opts.ext);
			return { ok: true, findings: [] };
		},
	};
}

describe.each([
	["demo", registerDemo],
	["rerun", registerRerun],
] as const)("%s on a CLI-only install", (name, register) => {
	beforeEach(() => setCliOnly(true));

	test("plays locally without --ext and prints no extension notice", async () => {
		const played: Played[] = [];
		const run = await world.drive(register, [name, world.planPath], deps(played));
		expect(run.code).toBe(0);
		expect(run.err).toBe("");
		expect(played).toHaveLength(0);
		expect(world.spawned).toHaveLength(1);
	});

	test("hands the plan to the extension player with --ext", async () => {
		const played: Played[] = [];
		await world.drive(register, [name, "--ext", world.planPath], deps(played));
		expect(played).toHaveLength(1);
		expect(played[0]?.ext).toBe(true);
		expect(world.spawned).toHaveLength(0);
	});

	test("the extension guard still refuses --ext", async () => {
		const program = new Command().exitOverride();
		program.enablePositionalOptions();
		guardExtensionCommands(program);
		(register as (p: Command, d: unknown) => void)(program, deps());
		await expect(
			program.parseAsync([name, "--ext", world.planPath], { from: "user" }),
		).rejects.toThrow("needs the dg-ai-extension");
	});
});

describe("demo --verify", () => {
	test("walks the plan locally without --ext and never plays it", async () => {
		const played: Played[] = [];
		const verified: boolean[] = [];
		const run = await world.drive(
			registerDemo,
			["demo", "--verify", world.planPath],
			deps(played, verified),
		);
		expect(run.code).toBe(0);
		expect(verified).toEqual([false]);
		expect(played).toHaveLength(0);
	});

	test("walks through the extension harness with --ext", async () => {
		const verified: boolean[] = [];
		await world.drive(
			registerDemo,
			["demo", "--ext", "--verify", world.planPath],
			deps([], verified),
		);
		expect(verified).toEqual([true]);
	});

	test("an unreadable plan skips the walk", async () => {
		const verified: boolean[] = [];
		await world.drive(
			registerDemo,
			["demo", "--verify", join(world.home, "missing.md")],
			deps([], verified),
		);
		expect(verified).toHaveLength(0);
	});
});

describe("demo without a script path", () => {
	test("exits 1 with the path error", async () => {
		const run = await world.drive(registerDemo, ["demo"], deps());
		expect(run.code).toBe(1);
		expect(run.err).toContain("a script path is required");
	});
});
