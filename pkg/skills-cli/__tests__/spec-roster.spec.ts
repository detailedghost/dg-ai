import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packagedPersonas } from "../src/proxy/packaged-personas";
import {
	baseEnv,
	disposeSpecContext,
	newSpecContext,
	runSourceSpec,
	type SpecContext,
} from "./spec-fixtures";

let context: SpecContext;
beforeEach(() => {
	context = newSpecContext();
});
afterEach(() => disposeSpecContext(context));

const roster = (args: string[], env: Record<string, string> = {}) =>
	runSourceSpec(["roster", ...args], {
		cwd: context.root,
		env: { ...baseEnv(context), ...env },
	});

describe("spec roster without a local agents directory", () => {
	test("lists every packaged persona as a dg: row", async () => {
		const run = await roster([]);
		const names = run.stdout
			.trimEnd()
			.split("\n")
			.map((row) => row.split("\t")[0]);

		expect(run.exitCode).toBe(0);
		expect(run.stderr).toBe("");
		expect(names).toEqual(
			Object.keys(packagedPersonas)
				.sort()
				.map((name) => `dg:${name}`),
		);
	});

	test("includes each persona description", async () => {
		const run = await roster([]);
		const row = run.stdout.split("\n").find((line) => line.startsWith("dg:reviewer\t"));

		expect(row?.split("\t")[1]).toBeTruthy();
	});

	test("adds the first body paragraph with --full", async () => {
		const run = await roster(["--full"]);
		const row = run.stdout.split("\n").find((line) => line.startsWith("dg:reviewer\t"));

		expect(row?.split("\t")).toHaveLength(3);
	});

	test("still fails when an explicit AGENTS_DIR does not exist", async () => {
		const run = await roster([], { AGENTS_DIR: join(context.root, "missing") });

		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("agents dir not found");
	});

	test("keeps listing the local directory when it exists", async () => {
		const dir = join(context.home, ".claude", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "custom.md"), "---\nname: custom\ndescription: Local only\n---\n\nBody.\n");

		const run = await roster([]);

		expect(run.stdout).toBe("custom\tLocal only\n");
	});
});
