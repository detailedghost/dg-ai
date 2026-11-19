import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { programName, setProgramName } from "@dg/common/node/program";
import { selfCommand } from "@dg/common/node/self-command";
import * as realAgent from "../src/programs/agent";
import * as realDaemon from "../src/programs/daemon";
import * as realSkills from "../src/programs/skills";

interface Seen {
	argv: string[];
	programName: string | undefined;
	selfArgv: string[];
}

let seen: Seen[];
let exitCode = 0;

function recorder() {
	return {
		main: async (argv: string[]): Promise<number> => {
			seen.push({ argv, programName: programName(), selfArgv: selfCommand(["x"]) });
			return exitCode;
		},
	};
}

mock.module("../src/programs/skills", recorder);
mock.module("../src/programs/daemon", recorder);
mock.module("../src/programs/agent", recorder);

const { dispatch } = await import("../src/dg");

beforeEach(() => {
	seen = [];
	exitCode = 0;
});

afterEach(() => setProgramName(undefined));

afterAll(() => {
	mock.module("../src/programs/skills", () => realSkills);
	mock.module("../src/programs/daemon", () => realDaemon);
	mock.module("../src/programs/agent", () => realAgent);
});

describe("dg in a bundle", () => {
	test("dg skills records dg-skills as the program name before the mounted main runs", async () => {
		expect(await dispatch(["dg", "skills", "stash"])).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.argv).toEqual(["stash"]);
		expect(seen[0]?.programName).toBe("dg-skills");
	});

	test("dg job records dg-daemon and passes the job group and the remaining arguments", async () => {
		await dispatch(["dg", "job", "list"]);
		expect(seen[0]?.argv).toEqual(["job", "list"]);
		expect(seen[0]?.programName).toBe("dg-daemon");
	});

	test("dg agent records dg-agent", async () => {
		await dispatch(["dg", "agent", "start"]);
		expect(seen[0]?.argv).toEqual(["start"]);
		expect(seen[0]?.programName).toBe("dg-agent");
	});

	test("dg upgrade and dg extension reach the dg-skills main as update and install", async () => {
		await dispatch(["dg", "upgrade", "--x"]);
		await dispatch(["dg", "extension", "firefox"]);
		expect(seen.map((call) => call.argv)).toEqual([["update", "--x"], ["install", "firefox"]]);
		expect(seen.map((call) => call.programName)).toEqual(["dg-skills", "dg-skills"]);
	});

	test("selfCommand below dg skills builds the same child argv as below dg-skills", async () => {
		await dispatch(["dg", "skills", "stash"]);
		await dispatch(["dg-skills", "stash"]);
		expect(seen).toHaveLength(2);
		expect(seen[0]?.selfArgv).toEqual(seen[1]?.selfArgv as string[]);
		expect(seen[0]?.selfArgv).toEqual([process.execPath, Bun.main, "dg-skills", "x"]);
	});

	test("selfCommand below dg job builds the dg-daemon child argv", async () => {
		await dispatch(["dg", "job", "list"]);
		expect(seen[0]?.selfArgv).toEqual([process.execPath, Bun.main, "dg-daemon", "x"]);
	});

	test("returns the exit code of the mounted main", async () => {
		exitCode = 3;
		expect(await dispatch(["dg", "doctor"])).toBe(3);
	});
});
