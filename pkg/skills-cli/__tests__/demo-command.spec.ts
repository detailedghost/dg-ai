import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectDemoMode } from "../src/commands/demo";
import { makeTempDir } from "./git-repo-fixtures";
import { collectRun } from "./spec-fixtures";

describe("selectDemoMode", () => {
	test("selects local by default, with no --ext flag", () => {
		expect(selectDemoMode({})).toBe("local");
		expect(selectDemoMode({ ext: false })).toBe("local");
	});

	test("selects ext only when --ext is passed", () => {
		expect(selectDemoMode({ ext: true })).toBe("ext");
	});
});

describe("dg-skills demo entry point", () => {
	const ENTRY = join(import.meta.dir, "../src/index.ts");
	let root: string;
	let cwd: string;
	let env: Record<string, string>;
	let planPath: string;

	beforeEach(() => {
		root = makeTempDir("dg-demo-dispatch-");
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(root, "dg-home"), { recursive: true });
		env = {
			...(process.env as Record<string, string>),
			AI_SCRATCH_DIR: join(root, "scratch"),
			DG_HOME: join(root, "dg-home"),
		};
		mkdirSync(env.AI_SCRATCH_DIR as string, { recursive: true });
		planPath = join(root, "tour.json");
		writeFileSync(
			planPath,
			JSON.stringify({
				title: "demo dispatch fixture",
				startUrl: "https://example.test/",
				steps: [{ title: "Step", body: "Body", advance: "next" }],
			}),
		);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const run = (args: string[]) =>
		collectRun(
			Bun.spawn([process.execPath, ENTRY, "demo", ...args], {
				cwd,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}),
		);

	test("--ext on a CLI-only install refuses before touching the extension", async () => {
		writeFileSync(join(root, "dg-home", "cli-only"), "");
		const result = await run(["--ext", planPath, "--print"]);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain(
			"dg-skills demo --ext needs the dg-ai-extension",
		);
	});
});
