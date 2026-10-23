import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchProto } from "../src/commands/proto";
import { makeTempDir } from "./git-repo-fixtures";
import { collectRun } from "./spec-fixtures";

const ENTRY = join(import.meta.dir, "../src/index.ts");

describe("dispatchProto", () => {
	const handlers = () => ({ local: mock(() => 0), extension: mock(() => 0) });

	test("no flag runs the local mode with every argument", () => {
		const h = handlers();
		dispatchProto(["ui", "m.md", "--light"], h);
		expect(h.local).toHaveBeenCalledWith(["ui", "m.md", "--light"]);
		expect(h.extension).not.toHaveBeenCalled();
	});

	test("no arguments at all run the local mode", () => {
		const h = handlers();
		dispatchProto([], h);
		expect(h.local).toHaveBeenCalledWith([]);
		expect(h.extension).not.toHaveBeenCalled();
	});

	test.each([
		[
			["--ext", "plant", "plan.json"],
			["plant", "plan.json"],
		],
		[
			["plant", "--ext", "plan.json", "--timeout", "5"],
			["plant", "plan.json", "--timeout", "5"],
		],
		[
			["scrape", "https://example.test", "--ext"],
			["scrape", "https://example.test"],
		],
	])("--ext in %j runs the extension flow without the flag", (argv, expected) => {
		const h = handlers();
		dispatchProto(argv, h);
		expect(h.extension).toHaveBeenCalledWith(expected);
		expect(h.local).not.toHaveBeenCalled();
	});
});

describe("dg-skills proto entry point", () => {
	let root: string;
	let env: Record<string, string>;
	let cwd: string;

	beforeEach(() => {
		root = makeTempDir("dg-proto-dispatch-");
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(root, "dg-home"), { recursive: true });
		env = {
			...(process.env as Record<string, string>),
			AI_SCRATCH_DIR: join(root, "scratch"),
			DG_HOME: join(root, "dg-home"),
		};
		mkdirSync(env.AI_SCRATCH_DIR as string, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const run = (args: string[]) =>
		collectRun(
			Bun.spawn([process.execPath, ENTRY, "proto", ...args], {
				cwd,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}),
		);

	test("plain proto runs the local mode, also on a CLI-only install", async () => {
		writeFileSync(join(root, "dg-home", "cli-only"), "");
		expect((await run(["confirm", "demo", "B", "--notes=ok"])).exitCode).toBe(
			0,
		);
		const claimed = await run(["wait", "demo", "--json"]);
		expect(claimed.stdout).toBe('{"status":"ok","variant":"B","notes":"ok"}\n');
	});

	test("plain proto with an extension verb says to add --ext", async () => {
		const result = await run(["plant", "plan.json"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("add --ext");
	});

	test("--ext runs the extension flow, which needs the extension on a CLI-only install", async () => {
		writeFileSync(join(root, "dg-home", "cli-only"), "");
		const result = await run(["--ext", "cleanup", "some-slug"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"dg-skills proto --ext needs the dg-ai-extension",
		);
	});

	test("--ext reaches the extension commands on a full install", async () => {
		const result = await run(["--ext", "cleanup", "some-slug"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no exported answer found for some-slug");
	});

	test("proto without arguments prints the local usage and points at --ext", async () => {
		const result = await run([]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Usage: prototype <command>");
		expect(result.stdout).toContain("proto --ext");
	});
});
