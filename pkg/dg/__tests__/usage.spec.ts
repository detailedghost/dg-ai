import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ROUTES } from "../src/main";
import { runDg } from "./fixtures";

let savedVersion: string | undefined;

beforeEach(() => {
	savedVersion = process.env.DG_BUILD_VERSION;
});

afterEach(() => {
	if (savedVersion === undefined) delete process.env.DG_BUILD_VERSION;
	else process.env.DG_BUILD_VERSION = savedVersion;
});

describe("dg usage", () => {
	test.each([[[]], [["--help"]], [["-h"]], [["help"]]] as const)("dg %j prints usage and exits 0", async (argv) => {
		const run = await runDg([...argv]);
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.loads).toEqual([]);
		expect(run.stdout.length).toBeGreaterThan(0);
	});

	test("every spelling of help prints the same text", async () => {
		const texts = await Promise.all([[], ["--help"], ["-h"], ["help"]].map((argv) => runDg(argv)));
		for (const run of texts) expect(run.stdout).toBe(texts[0]?.stdout as string);
	});

	test("lists each name of the routing table with its description", async () => {
		const { stdout } = await runDg(["--help"]);
		const lines = stdout.split("\n").map((line) => line.trim());
		for (const [name, row] of Object.entries(ROUTES)) {
			expect(lines.some((line) => line.startsWith(`${name} `) && line.endsWith(row.description))).toBe(true);
		}
	});

	test("names the target program on every row", async () => {
		const { stdout } = await runDg(["--help"]);
		const lines = stdout.split("\n").map((line) => line.trim());
		for (const [name, row] of Object.entries(ROUTES)) {
			const target = [row.program, ...row.command].join(" ");
			expect(lines.some((line) => line.startsWith(`${name} `) && line.endsWith(`(runs ${target})`))).toBe(true);
		}
	});

	test("lists completion on its own line", async () => {
		const { stdout } = await runDg(["--help"]);
		expect(stdout.split("\n").filter((line) => line.trim().startsWith("completion "))).toHaveLength(1);
	});

	test("does not list service, start, stop or status as a command", async () => {
		const { stdout } = await runDg(["--help"]);
		const first = stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]);
		for (const word of ["service", "start", "stop", "status"]) expect(first).not.toContain(word);
	});

	test("the extension line says it runs dg-skills install", async () => {
		const { stdout } = await runDg(["--help"]);
		const lines = stdout.split("\n").map((line) => line.trim());
		const pattern = /^extension\s+stage the browser extension \(runs dg-skills install\)$/;
		expect(lines.some((line) => pattern.test(line))).toBe(true);
	});
});

describe("dg --version", () => {
	test("prints dev when DG_BUILD_VERSION is not set", async () => {
		delete process.env.DG_BUILD_VERSION;
		const run = await runDg(["--version"]);
		expect(run.code).toBe(0);
		expect(run.stdout).toBe("dev\n");
		expect(run.loads).toEqual([]);
	});

	test("prints DG_BUILD_VERSION when it is set", async () => {
		process.env.DG_BUILD_VERSION = "9.8.7";
		expect((await runDg(["--version"])).stdout).toBe("9.8.7\n");
	});

	test("prints the version when more words follow", async () => {
		delete process.env.DG_BUILD_VERSION;
		const run = await runDg(["--version", "extra"]);
		expect(run.code).toBe(0);
		expect(run.stdout).toBe("dev\n");
	});
});
