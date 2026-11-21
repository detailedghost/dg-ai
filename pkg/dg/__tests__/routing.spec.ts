import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPLETION_SHELLS, completionScript, type CompletionShell } from "@dg/common/completion";
import { programCommand } from "@dg/common/node/program";
import { ALIASES, flatRows, GROUPS } from "../src/flat";
import type { MountName } from "../src/main";
import { runDg } from "./fixtures";

const EXPECTED_ROUTES: ReadonlyArray<readonly [string, MountName, string[]]> = [
	["job", "dg-daemon", ["job"]],
	["autostart", "dg-daemon", ["autostart"]],
	["daemon", "dg-daemon", []],
	["skills", "dg-skills", []],
	["agent", "dg-agent", []],
	["extension", "dg-skills", ["install"]],
	["install", "dg-skills", ["install"]],
	["upgrade", "dg-skills", ["update"]],
	["doctor", "dg-skills", ["doctor"]],
	["update", "dg-skills", ["update"]],
	["pw", "dg-skills", ["pw"]],
	["phone", "dg-agent", ["phone"]],
	["service", "dg-daemon", ["service"]],
];

const UNKNOWN = (word: string) => `dg: unknown command "${word}"; run dg --help\n`;

describe("main.ts", () => {
	test("gives each flat row a non-empty one-line description", () => {
		for (const row of flatRows()) expect(row.description).toMatch(/^\S.*\S$/);
	});

	test("importing main.ts imports no program and no value statically", () => {
		const source = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
		expect(source).not.toMatch(/@dg\/(dg-daemon|skills-cli|dg-agent)/);
		expect(source).not.toMatch(/\.\/programs\//);
		const staticValueImports = source
			.split("\n")
			.filter((line) => /^import\s/.test(line) && !/^import\s+type\s/.test(line));
		expect(staticValueImports).toEqual([]);
	});
});

describe("routing to mounted programs", () => {
	test.each(EXPECTED_ROUTES)("dg %s passes the command then the remaining arguments", async (name, program, command) => {
		const run = await runDg([name, "a", "--b", "c"]);
		expect(run.calls.map(({ program: p, argv }) => ({ program: p, argv }))).toEqual([
			{ program, argv: [...command, "a", "--b", "c"] },
		]);
		expect(run.code).toBe(0);
	});

	test.each(EXPECTED_ROUTES)("dg %s with no more arguments passes only the command", async (name, program, command) => {
		const run = await runDg([name]);
		expect(run.calls).toHaveLength(1);
		expect(run.calls[0]?.program).toBe(program);
		expect(run.calls[0]?.argv).toEqual(command);
	});

	test("loads only the loader of the mount that the route uses", async () => {
		expect((await runDg(["job", "list"])).loads).toEqual(["dg-daemon"]);
		expect((await runDg(["doctor"])).loads).toEqual(["dg-skills"]);
		expect((await runDg(["agent", "start"])).loads).toEqual(["dg-agent"]);
	});

	test("dg extension and dg install give the mount the same argv", async () => {
		const extension = await runDg(["extension", "firefox", "--x"]);
		const install = await runDg(["install", "firefox", "--x"]);
		expect(extension.calls[0]?.argv).toEqual(["install", "firefox", "--x"]);
		expect(install.calls[0]?.argv).toEqual(extension.calls[0]?.argv as string[]);
	});

	test("keeps the arguments after -- and an empty argument intact", async () => {
		const run = await runDg(["skills", "stash", "--", "--x", ""]);
		expect(run.calls[0]?.argv).toEqual(["stash", "--", "--x", ""]);
	});

	test("returns the exit code of the mounted main", async () => {
		expect((await runDg(["skills", "x"], { "dg-skills": 3 })).code).toBe(3);
		expect((await runDg(["job", "x"], { "dg-daemon": 7 })).code).toBe(7);
	});

	test("passes --version after a route to the mounted program", async () => {
		for (const name of ["daemon", "skills", "agent"]) {
			const run = await runDg([name, "--version"]);
			expect(run.calls[0]?.argv).toEqual(["--version"]);
		}
	});

	test("dg help <name> calls the mount as dg <name> --help does", async () => {
		for (const [name] of EXPECTED_ROUTES) {
			const help = await runDg(["help", name]);
			const direct = await runDg([name, "--help"]);
			expect(help.calls).toHaveLength(1);
			expect(help.calls[0]?.program).toBe(direct.calls[0]?.program as MountName);
			expect(help.calls[0]?.argv).toEqual(direct.calls[0]?.argv as string[]);
			expect(help.code).toBe(direct.code);
			expect(help.stdout).toBe(direct.stdout);
		}
	});

	test("dg help job calls the dg-daemon main with job --help", async () => {
		expect((await runDg(["help", "job"])).calls[0]?.argv).toEqual(["job", "--help"]);
	});
});

describe("mounting the program name", () => {
	test("in a checkout the mounted program sees its own source entry and programName stays undefined", async () => {
		const skills = await runDg(["skills", "stash"]);
		expect(skills.calls[0]?.mountedAtCall).toBeUndefined();
		expect(skills.calls[0]?.selfArgv).toEqual(programCommand("dg-skills", ["x"]));
		const daemon = await runDg(["job", "list"]);
		expect(daemon.calls[0]?.selfArgv).toEqual(programCommand("dg-daemon", ["x"]));
		const agent = await runDg(["agent", "start"]);
		expect(agent.calls[0]?.selfArgv).toEqual(programCommand("dg-agent", ["x"]));
		expect(skills.calls[0]?.selfArgv[1]).toMatch(/pkg[\\/]skills-cli[\\/]src[\\/]index\.ts$/);
		expect(daemon.calls[0]?.selfArgv[1]).toMatch(/pkg[\\/]dg-daemon[\\/]src[\\/]index\.ts$/);
		expect(agent.calls[0]?.selfArgv[1]).toMatch(/pkg[\\/]dg-agent[\\/]src[\\/]index\.ts$/);
	});

	test("routes that share a program mount the same program", async () => {
		for (const name of ["extension", "install", "upgrade", "doctor", "skills"]) {
			const run = await runDg([name]);
			expect(run.calls[0]?.selfArgv[1]).toMatch(/pkg[\\/]skills-cli[\\/]src[\\/]index\.ts$/);
		}
	});
});

describe("unknown input", () => {
	test.each([
		"nope",
		"toString",
		"constructor",
		"__proto__",
		"Job",
		"",
		"--nope",
		"dg-skills",
	])("dg %p exits 1 with the unknown-command error and no stdout", async (word) => {
		const run = await runDg([word]);
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(UNKNOWN(word));
		expect(run.stdout).toBe("");
		expect(run.loads).toEqual([]);
	});

	test.each(["start", "serve", "send"])("dg %p exits 1 with a hint that names its group path", async (word) => {
		const run = await runDg([word]);
		expect(run.code).toBe(1);
		expect(run.stderr).toContain(`dg daemon ${word}`.replace("dg daemon send", "dg agent send"));
		expect(run.stdout).toBe("");
		expect(run.loads).toEqual([]);
	});

	test("dg start names dg daemon start and dg agent start", async () => {
		const run = await runDg(["start"]);
		expect(run.code).toBe(1);
		expect(run.stderr).toBe('dg: "start" stays under its group; run dg agent start or dg daemon start\n');
	});

	test.each(["nope", "toString"])("dg help %p names an unknown word", async (word) => {
		const run = await runDg(["help", word]);
		expect(run.code).toBe(1);
		expect(run.stderr).toBe(UNKNOWN(word));
		expect(run.stdout).toBe("");
		expect(run.loads).toEqual([]);
	});
});

describe("completion", () => {
	test.each(COMPLETION_SHELLS)("dg completion %s prints the script for dg", async (shell) => {
		const run = await runDg(["completion", shell]);
		expect(run.code).toBe(0);
		expect(run.stdout).toBe(completionScript(shell as CompletionShell, "dg"));
		expect(run.loads).toEqual([]);
	});

	test("dg completion nope and dg completion with no shell exit 1 with the same error naming the shells", async () => {
		const bad = await runDg(["completion", "nope"]);
		const none = await runDg(["completion"]);
		expect(bad.code).toBe(1);
		for (const shell of COMPLETION_SHELLS) expect(bad.stdout + bad.stderr).toContain(shell);
		expect(none.code).toBe(bad.code);
		expect(none.stderr).toBe(bad.stderr);
		expect(none.stdout).toBe(bad.stdout);
	});

	test("dg __complete with one empty word lists the flat names, groups, aliases, completion and help", async () => {
		const run = await runDg(["__complete", ""]);
		expect(run.code).toBe(0);
		const lines = run.stdout.trimEnd().split("\n");
		const names = lines.map((line) => line.split("\t")[0]).sort();
		const expected = [...flatRows().map((row) => row.name), ...Object.keys(GROUPS), ...Object.keys(ALIASES), "completion", "help"];
		expect(names).toEqual(expected.sort());
		for (const line of lines) expect(line).toMatch(/^[^\t]+\t\S/);
		expect(names).toContain("pw");
		expect(names).toContain("phone");
		expect(names).not.toContain("start");
		expect(run.loads).toEqual([]);
	});

	test("dg __complete pw calls the skills tree with pw", async () => {
		const run = await runDg(["__complete", "pw", ""]);
		expect(run.calls.map((call) => ({ program: call.program, argv: call.argv }))).toEqual([
			{ program: "dg-skills", argv: ["__complete", "pw", ""] },
		]);
	});

	test("dg __complete autos prints only autostart", async () => {
		const run = await runDg(["__complete", "autos"]);
		expect(run.code).toBe(0);
		expect(run.stdout.trimEnd().split("\n").map((line) => line.split("\t")[0])).toEqual(["autostart"]);
	});

	test.each([
		[["job", "add", "--na"], "dg-daemon", ["__complete", "job", "add", "--na"]],
		[["job", ""], "dg-daemon", ["__complete", "job", ""]],
		[["autostart", ""], "dg-daemon", ["__complete", "autostart", ""]],
		[["daemon", "st"], "dg-daemon", ["__complete", "st"]],
		[["skills", ""], "dg-skills", ["__complete", ""]],
		[["agent", "ph"], "dg-agent", ["__complete", "ph"]],
		[["upgrade", "--x"], "dg-skills", ["__complete", "update", "--x"]],
		[["upgrade", ""], "dg-skills", ["__complete", "update", ""]],
		[["extension", ""], "dg-skills", ["__complete", "install", ""]],
		[["doctor", ""], "dg-skills", ["__complete", "doctor", ""]],
	] as const)("dg __complete %j calls %s with %j", async (words, program, argv) => {
		const run = await runDg(["__complete", ...words]);
		expect(run.calls.map((call) => ({ program: call.program, argv: call.argv }))).toEqual([{ program, argv: [...argv] }]);
		expect(run.code).toBe(0);
	});

	test("dg __complete with two words and a first word that is not a route prints nothing and exits 0", async () => {
		for (const words of [["nope", "x"], ["toString", "x"], ["completion", "x"], ["help", "x"], ["start", ""]]) {
			const run = await runDg(["__complete", ...words]);
			expect(run.code).toBe(0);
			expect(run.stdout).toBe("");
			expect(run.stderr).toBe("");
			expect(run.calls).toEqual([]);
		}
	});
});
