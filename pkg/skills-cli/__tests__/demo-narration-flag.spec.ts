import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

async function drive(...args: string[]) {
	return world.drive(registerDemo, ["demo", ...args, world.planPath], deps());
}

describe("demo --narration", () => {
	test("passes the chosen narration to the player job of a video run", async () => {
		const run = await drive("--video", "--narration", "both");
		expect(run.code).toBe(0);
		expect(playerJob().narration).toBe("both");
	});

	test("falls back to the saved choice for the slug when the flag is absent", async () => {
		await drive("--video");
		const slug = String(playerJob().slug);
		world.spawned.length = 0;
		const saved = join(world.demosDir, slug);
		mkdirSync(saved, { recursive: true });
		writeFileSync(
			join(saved, "choice.json"),
			JSON.stringify({ mode: "video", narration: "voice", voice: "am_adam" }),
		);
		await drive("--video");
		expect(playerJob()).toMatchObject({ narration: "voice", voice: "am_adam" });
	});

	test("lets the flag win over the saved choice", async () => {
		await drive("--video");
		const slug = String(playerJob().slug);
		world.spawned.length = 0;
		writeFileSync(
			join(world.demosDir, slug, "choice.json"),
			JSON.stringify({ mode: "video", narration: "voice" }),
		);
		await drive("--video", "--narration", "captions");
		expect(playerJob().narration).toBe("captions");
	});

	test("stores the flag value in choice.json and keeps the other saved fields", async () => {
		await drive("--video");
		const slug = String(playerJob().slug);
		const file = join(world.demosDir, slug, "choice.json");
		writeFileSync(file, JSON.stringify({ mode: "video", voice: "am_adam" }));
		await drive("--video", "--narration", "captions");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
			mode: "video",
			voice: "am_adam",
			narration: "captions",
		});
	});

	test("stores the flag value when no choice.json exists yet", async () => {
		await drive("--video", "--narration", "voice");
		const slug = String(playerJob().slug);
		const file = join(world.demosDir, slug, "choice.json");
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ narration: "voice" });
	});

	test("sets no narration when neither the flag nor a saved choice exists", async () => {
		await drive("--video");
		expect(playerJob().narration).toBeUndefined();
	});

	test("refuses the flag without --video", async () => {
		const run = await drive("--narration", "both");
		expect(run.code).toBe(1);
		expect(run.err).toContain("--narration needs --video");
		expect(world.spawned).toHaveLength(0);
	});

	test("rejects an unknown mode", async () => {
		await expect(drive("--video", "--narration", "loud")).rejects.toThrow(
			"Allowed choices",
		);
		expect(world.spawned).toHaveLength(0);
	});

	test("is local-only: --ext refuses it", async () => {
		const run = await drive("--ext", "--video", "--narration", "both");
		expect(run.code).toBe(1);
		expect(run.err).toContain("--narration");
	});
});
