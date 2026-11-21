import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ALIASES, flatRows, GROUPS } from "../src/flat";
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
	test.each([[[]], [["--help"]], [["-h"]], [["help"]], [["help", "help"]], [["help", "completion"]]] as const)("dg %j prints usage and exits 0", async (argv) => {
		const run = await runDg([...argv]);
		expect(run.code).toBe(0);
		expect(run.stderr).toBe("");
		expect(run.loads).toEqual([]);
		expect(run.stdout.length).toBeGreaterThan(0);
	});

	test("every spelling of help prints the same text", async () => {
		const texts = [];
		for (const argv of [[], ["--help"], ["-h"], ["help"], ["help", "help"], ["help", "completion"]]) texts.push(await runDg(argv));
		for (const run of texts) expect(run.stdout).toBe(texts[0]?.stdout as string);
	});

	test("lists each flat name with its description under its area", async () => {
		const { stdout } = await runDg(["--help"]);
		const lines = stdout.split("\n").map((line) => line.trim());
		for (const row of flatRows()) {
			expect(lines.some((line) => line.startsWith(`${row.name} `) && line.endsWith(row.description))).toBe(true);
		}
		for (const title of ["Skills commands:", "Agent commands:", "Daemon commands:", "Groups:", "Aliases:", "Other:"])
			expect(lines).toContain(title);
	});

	test("lists the groups and the aliases", async () => {
		const { stdout } = await runDg(["--help"]);
		const first = stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]);
		for (const word of [...Object.keys(GROUPS), ...Object.keys(ALIASES), "pw", "phone", "job", "service"]) expect(first).toContain(word);
	});

	test("lists completion on its own line", async () => {
		const { stdout } = await runDg(["--help"]);
		expect(stdout.split("\n").filter((line) => line.trim().startsWith("completion "))).toHaveLength(1);
	});

	test("does not list a grouped verb as a command", async () => {
		const { stdout } = await runDg(["--help"]);
		const first = stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]);
		for (const word of ["start", "stop", "status", "serve", "send"]) expect(first).not.toContain(word);
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
