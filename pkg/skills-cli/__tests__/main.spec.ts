import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as realJot from "../src/jot";
import * as realStash from "../src/stash";

mock.module("../src/stash", () => ({
	...realStash,
	main: (argv: string[]) =>
		argv[0] === "--stub-exit" ? Number(argv[1]) : realStash.main(argv),
}));

mock.module("../src/jot", () => ({
	...realJot,
	jotSpec: {
		...realJot.jotSpec,
		subcommands: {
			...realJot.jotSpec.subcommands,
			"stub-exit": { run: async (args: string[]) => Number(args[0]) },
		},
	},
}));

const { main } = await import("../src/main");

const realExit = process.exit;
const realError = console.error;
const realExitCode = process.exitCode;
let exitCalls: unknown[];

beforeEach(() => {
	exitCalls = [];
	process.exit = ((code?: number) => {
		exitCalls.push(code);
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit;
	console.error = () => {};
	process.exitCode = 0;
});

afterEach(() => {
	process.exit = realExit;
	console.error = realError;
	process.exitCode = realExitCode ?? 0;
});

describe("dg-skills main", () => {
	it("returns 0 for exactly --version without calling process.exit", async () => {
		const written: string[] = [];
		const realWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		let code: number;
		try {
			code = await main(["--version"]);
		} finally {
			process.stdout.write = realWrite;
		}
		expect(code).toBe(0);
		expect(written.join("").trim()).toMatch(/^\S+$/);
		expect(exitCalls).toEqual([]);
	});

	it("returns 1 for an unknown command without calling process.exit", async () => {
		const code = await main(["no-such-command"]);
		expect(code).toBe(1);
		expect(exitCalls).toEqual([]);
	});

	it("returns the exit code of a lazy raw command without calling process.exit", async () => {
		const code = await main(["stash", "--stub-exit", "7"]);
		expect(code).toBe(7);
		expect(exitCalls).toEqual([]);
	});

	it("returns the exit code of a lazy legacy subcommand without calling process.exit", async () => {
		const code = await main(["jot", "stub-exit", "3"]);
		expect(code).toBe(3);
		expect(exitCalls).toEqual([]);
	});
});

describe("dg-skills main through feature modules that used to exit", () => {
	const realLog = console.log;
	const realStdoutWrite = process.stdout.write;
	const realStderrWrite = process.stderr.write;

	beforeEach(() => {
		console.log = () => {};
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
	});

	afterEach(() => {
		console.log = realLog;
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
	});

	it.each([
		[["chain"], 1],
		[["chain", "--help"], 0],
		[["chain", "bogus", "a"], 1],
		[["proxy"], 1],
		[["proxy", "no-such-backend", "--prompt", "hi"], 1],
		[["demo"], 1],
		[["meaningful", "abort"], 2],
	])("returns the exit code of %p without calling process.exit", async (argv, expected) => {
		const code = await main(argv);
		expect(code).toBe(expected);
		expect(exitCalls).toEqual([]);
	});

	it("writes the die message to stderr and returns its code", async () => {
		const written: string[] = [];
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		const code = await main(["meaningful", "abort"]);
		expect(code).toBe(2);
		expect(written.join("")).toContain("error: usage: abort <backup-ref>");
		expect(exitCalls).toEqual([]);
	});

	it.each([
		"launch/cli.ts",
		"proxy/cli.ts",
		"chain/index.ts",
		"demo/cli.ts",
		"address/index.ts",
		"channel-review/cli.ts",
		"deps-upgrade/index.ts",
	])("keeps %s free of a bare process.exit so the entry point can drain output", (file) => {
		const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
		expect(source).not.toContain("process.exit(");
	});
});
