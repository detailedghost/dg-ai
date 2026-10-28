import { describe, expect, test } from "bun:test";

import { packagedPersonas } from "../src/proxy/packaged-personas";
import { loadTiers, resolveAgent } from "../src/tiers";

const RUNTIMES = ["claude", "codex", "grok"] as const;

describe("tier table", () => {
	const table = loadTiers();

	test("gives every tier a row for each runtime with a non-empty effort", () => {
		for (const row of Object.values(table.tiers)) {
			for (const runtime of RUNTIMES) expect(row[runtime].effort).not.toBe("");
		}
	});

	test("gives claude and grok a non-empty model on every tier", () => {
		for (const row of Object.values(table.tiers)) {
			expect(row.claude.model).toBeTruthy();
			expect(row.grok.model).toBeTruthy();
		}
	});

	test("lists exactly the packaged persona names", () => {
		expect(Object.keys(table.agents).sort()).toEqual(
			Object.keys(packagedPersonas).sort(),
		);
	});

	test("maps exactly the fableAgents to fable", () => {
		const fable = Object.entries(table.agents)
			.filter(([, tier]) => tier === "fable")
			.map(([name]) => name)
			.sort();
		expect(fable).toEqual([...table.fableAgents].sort());
	});
});

describe("resolveAgent", () => {
	test("throws when a non-fable agent requests fable", () => {
		expect(() =>
			resolveAgent("js", { runtime: "claude", tier: "fable" }),
		).toThrow(/fable/);
	});

	test("resolves an unlisted agent to sonnet medium on claude", () => {
		expect(resolveAgent("nobody", { runtime: "claude" })).toEqual({
			model: "sonnet",
			effort: "medium",
			tier: "sonnet",
		});
	});

	test("raises a sonnet agent to the explicit effort", () => {
		expect(resolveAgent("js", { runtime: "claude", effort: "xhigh" })).toEqual({
			model: "sonnet",
			effort: "xhigh",
			tier: "sonnet",
		});
	});

	test("rejects an effort override outside low, medium and xhigh", () => {
		expect(() => resolveAgent("js", { runtime: "claude", effort: "high" })).toThrow(
			'Effort "high" is not allowed; use low, medium or xhigh.',
		);
	});

	test("resolves dba to opus xhigh on claude", () => {
		expect(resolveAgent("dba", { runtime: "claude" })).toMatchObject({
			model: "opus",
			effort: "xhigh",
		});
	});

	test.each(["wave", "checkpoint"])("resolves %s to haiku low", (name) => {
		expect(resolveAgent(name, { runtime: "claude" })).toMatchObject({
			model: "haiku",
			effort: "low",
		});
	});

	test("resolves a fable agent to fable xhigh on claude", () => {
		expect(resolveAgent("arch", { runtime: "claude" })).toEqual({
			model: "fable",
			effort: "xhigh",
			tier: "fable",
		});
	});

	test.each(["codex", "grok"] as const)(
		"resolves arch on %s through the opus row",
		(runtime) => {
			const opus = loadTiers().tiers.opus[runtime];
			expect(resolveAgent("arch", { runtime })).toEqual({
				model: opus.model,
				effort: opus.effort,
				tier: "opus",
			});
		},
	);
});

describe("resolveAgent effort override", () => {
	test("rejects an empty effort", () => {
		expect(() => resolveAgent("js", { runtime: "claude", effort: "" })).toThrow(
			"Effort",
		);
	});
});
