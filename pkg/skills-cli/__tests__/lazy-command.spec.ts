import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { registerLazyLegacy, registerLazyRaw } from "../src/utils/lazy-command";

const realExit = process.exit;
const realExitCode = process.exitCode;
let exitCalls: unknown[];

beforeEach(() => {
	exitCalls = [];
	process.exitCode = 0;
	process.exit = ((code?: number) => {
		exitCalls.push(code);
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit;
});

afterEach(() => {
	process.exit = realExit;
	process.exitCode = realExitCode ?? 0;
});

async function run(
	program: Command,
	argv: string[],
): Promise<number | undefined> {
	await program.parseAsync(argv, { from: "user" });
	expect(exitCalls).toEqual([]);
	return typeof process.exitCode === "number" ? process.exitCode : undefined;
}

describe("registerLazyRaw", () => {
	it("does not call load until the command runs", () => {
		let loads = 0;
		const program = new Command();
		registerLazyRaw(program, {
			name: "thing",
			description: "a thing",
			load: async () => {
				loads += 1;
				return { main: () => 0 };
			},
		});
		expect(program.commands.map((c) => c.name())).toEqual(["thing"]);
		expect(program.commands[0]?.description()).toBe("a thing");
		expect(loads).toBe(0);
	});

	it("forwards the argv and the handler exit code unchanged", async () => {
		const seen: string[][] = [];
		const program = new Command();
		registerLazyRaw(program, {
			name: "thing",
			description: "a thing",
			load: async () => ({
				main: async (argv: string[]) => {
					seen.push(argv);
					return 7;
				},
			}),
		});
		expect(await run(program, ["thing", "--flag", "x"])).toBe(7);
		expect(seen).toEqual([["--flag", "x"]]);
	});

	it("does not exit when the handler returns nothing", async () => {
		const program = new Command();
		registerLazyRaw(program, {
			name: "thing",
			description: "a thing",
			load: async () => ({ main: () => {} }),
		});
		expect(await run(program, ["thing"])).toBe(0);
	});
});

describe("registerLazyLegacy", () => {
	it("does not call load until the command runs", () => {
		let loads = 0;
		const program = new Command();
		registerLazyLegacy(program, {
			name: "legacy",
			description: "a legacy thing",
			load: async () => {
				loads += 1;
				return { name: "legacy", subcommands: {} };
			},
		});
		expect(program.commands.map((c) => c.name())).toEqual(["legacy"]);
		expect(loads).toBe(0);
	});

	it("forwards the subcommand exit code unchanged", async () => {
		const program = new Command();
		registerLazyLegacy(program, {
			name: "legacy",
			description: "a legacy thing",
			load: async () => ({
				name: "legacy",
				subcommands: { go: { run: async () => 3 } },
			}),
		});
		expect(await run(program, ["legacy", "go"])).toBe(3);
	});
});
