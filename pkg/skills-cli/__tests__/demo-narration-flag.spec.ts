import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerDemo } from "../src/commands/demo";
import { type DemoWorld, demoWorld } from "./demo-local-fixtures";

let world: DemoWorld;
beforeEach(() => {
	world = demoWorld();
});
afterEach(() => {
	world.cleanup();
});

const deps = () => ({
	play: async () => {
		throw new Error("the extension path must not run");
	},
	local: world.localDeps(),
});

function playerJob(): Record<string, unknown> {
	const argv = world.spawned[0]?.argv ?? [];
	return JSON.parse(argv[argv.length - 1] ?? "null");
}

describe("demo --narration", () => {
	test.each(["--narration", "-n"])("%s turns narration on in the player job", async (flag) => {
		const run = await world.drive(registerDemo, ["demo", flag, world.planPath], deps());
		expect(run.code).toBe(0);
		expect(playerJob().narration).toBe(true);
	});

	test("is off by default", async () => {
		await world.drive(registerDemo, ["demo", world.planPath], deps());
		expect(playerJob()).not.toHaveProperty("narration");
	});

	test("takes no value: a mode after it is not accepted", async () => {
		await expect(
			world.drive(registerDemo, ["demo", "--narration", "both", world.planPath], deps()),
		).rejects.toThrow("too many arguments");
		expect(world.spawned).toHaveLength(0);
	});

	test("a mode as the only argument is read as a plan path and fails clearly", async () => {
		await expect(
			world.drive(registerDemo, ["demo", "--narration", "both"], deps()),
		).rejects.toThrow();
		expect(world.spawned).toHaveLength(0);
	});

	test("is local-only: --ext refuses it", async () => {
		const run = await world.drive(registerDemo, ["demo", "--ext", "--narration", world.planPath], deps());
		expect(run.code).toBe(1);
		expect(run.err).toContain("--narration");
	});
});
