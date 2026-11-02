import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toPlanMarkdown } from "@dg/common";
import { registerRerun } from "../src/commands/rerun";
import { type DemoWorld, TWO_STEP_PLAN, demoWorld } from "./demo-local-fixtures";

let world: DemoWorld;
let legacyPlan: string;

beforeEach(() => {
	world = demoWorld();
	const dir = join(world.home, ".dg", "demos", "old");
	mkdirSync(dir, { recursive: true });
	legacyPlan = join(dir, "old.demo.md");
	writeFileSync(legacyPlan, toPlanMarkdown(TWO_STEP_PLAN as never));
});
afterEach(() => world.cleanup());

const deps = (played: unknown[] = []) => ({
	play: async (script: unknown) => void played.push(script),
	local: world.localDeps(),
});

function job(): Record<string, unknown> {
	const argv = world.spawned[0]?.argv ?? [];
	return JSON.parse(argv[argv.length - 1] ?? "null");
}

describe("rerun <plan>", () => {
	test("reads a plan under the legacy ~/.dg/demos dir and plays locally", async () => {
		const played: unknown[] = [];
		const run = await world.drive(registerRerun, ["rerun", legacyPlan], deps(played));
		expect(run.code).toBe(0);
		expect(played).toHaveLength(0);
		expect(world.spawned).toHaveLength(1);
		expect(run.out).toContain("start screen open in");
	});

	test("resolves a bare plan file name through the legacy demos dir", async () => {
		const run = await world.drive(registerRerun, ["rerun", "old.demo.md"], deps());
		expect(run.code).toBe(0);
		expect(world.spawned).toHaveLength(1);
	});

	test("passes --video through to the player job", async () => {
		await world.drive(registerRerun, ["rerun", "--video", legacyPlan], deps());
		expect(job().video).toBe(true);
	});

	test("--ext replays through playScript and spawns no player", async () => {
		const played: unknown[] = [];
		await world.drive(registerRerun, ["rerun", "--ext", legacyPlan], deps(played));
		expect(played).toHaveLength(1);
		expect(world.spawned).toHaveLength(0);
	});

	test("--print without --ext exits 1 naming --ext", async () => {
		const run = await world.drive(registerRerun, ["rerun", "--print", legacyPlan], deps());
		expect(run.code).toBe(1);
		expect(run.err).toContain("--ext");
		expect(world.spawned).toHaveLength(0);
	});
});
