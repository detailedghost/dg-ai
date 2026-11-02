import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toPlanMarkdown } from "@dg/common";
import { demosDir } from "../src/demo/paths";
import { findPlan, loadScript, savePlan } from "../src/demo/plan-file";
import { type DemoWorld, TWO_STEP_PLAN, demoWorld } from "./demo-local-fixtures";

let world: DemoWorld;
beforeEach(() => {
	world = demoWorld();
});
afterEach(() => world.cleanup());

describe("savePlan and loadScript", () => {
	test("saves under <demosDir>/<slug>/<slug>.demo.md and loads back the same steps", () => {
		const path = savePlan(TWO_STEP_PLAN as never);
		expect(path).toBe(join(demosDir(), "local-player-tour", "local-player-tour.demo.md"));
		const loaded = loadScript(path);
		expect(loaded.steps.map((s) => s.title)).toEqual(["First stop", "Second stop"]);
	});

	test("loads raw script JSON from a non-.md path", () => {
		expect(loadScript(world.planPath).title).toBe(TWO_STEP_PLAN.title);
	});

	test("rejects an invalid script", () => {
		const bad = join(world.home, "bad.json");
		writeFileSync(bad, JSON.stringify({ title: "x" }));
		expect(() => loadScript(bad)).toThrow();
	});
});

describe("findPlan", () => {
	test("an existing path wins", () => {
		expect(findPlan(world.planPath)).toBe(world.planPath);
	});

	test("finds a bare slug under the demos dir", () => {
		const path = savePlan(TWO_STEP_PLAN as never);
		expect(findPlan("local-player-tour")).toBe(path);
	});

	test("finds a bare file name in any slug dir, then in the legacy dir", () => {
		const legacy = join(world.home, ".dg", "demos", "old");
		mkdirSync(legacy, { recursive: true });
		const file = join(legacy, "old.demo.md");
		writeFileSync(file, toPlanMarkdown(TWO_STEP_PLAN as never));
		expect(findPlan("old.demo.md")).toBe(file);
		expect(readFileSync(findPlan("old"), "utf8")).toContain("First stop");
	});

	test("returns an unresolved name unchanged", () => {
		expect(findPlan("missing-plan")).toBe("missing-plan");
		expect(findPlan("some/dir/missing.md")).toBe("some/dir/missing.md");
	});
});
