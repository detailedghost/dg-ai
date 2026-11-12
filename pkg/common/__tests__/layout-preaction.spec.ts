import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { DgCliError } from "../src/errors";
import { resolveDgPaths } from "@dg/common/node/dg-paths";
import { ensureLayout, type LayoutHooks, type LayoutResult, withCliLockError } from "@dg/common/node/layout";
import { installLayoutPreAction, shouldSkip } from "@dg/common/node/layout-preaction";

const SKILLS_SKIP = new Set(["hooks run"]);
const AGENT_SKIP = new Set(["phone listen"]);
const DAEMON_SKIP = new Set(["status"]);

const SKILLS_TREE = ["hooks run", "spec slugify", "doctor", "clean", "install"];
const AGENT_TREE = ["phone listen", "phone status", "memory search", "start"];
const DAEMON_TREE = ["status", "serve", "job list"];

function stub(paths: readonly string[], ran: string[]): Command {
	const root = new Command().name("prog").exitOverride();
	for (const path of paths) {
		const parts = path.split(" ");
		let parent = root;
		parts.forEach((part, index) => {
			const child = parent.commands.find((candidate) => candidate.name() === part) ?? parent.command(part);
			if (index === parts.length - 1) {
				child
					.allowExcessArguments()
					.argument("[rest...]")
					.action(() => {
						ran.push(path);
					});
			}
			parent = child;
		});
	}
	return root;
}

function leaf(root: Command, path: string): Command {
	return path.split(" ").reduce<Command>((parent, part) => {
		const child = parent.commands.find((candidate) => candidate.name() === part);
		if (!child) throw new Error(`stub tree has no ${path}`);
		return child;
	}, root);
}

type EnsureCall = { paths: unknown; hooks: LayoutHooks };

function wire(tree: readonly string[], skip: ReadonlySet<string>) {
	const ran: string[] = [];
	const ensured: EnsureCall[] = [];
	const order: string[] = [];
	const result = {} as LayoutResult;
	const program = stub(tree, ran);
	installLayoutPreAction(program, {
		skip,
		hooksFor: () => ({}),
		after: async () => {
			order.push("after");
		},
		ensure: async (paths: unknown, hooks: LayoutHooks) => {
			ensured.push({ paths, hooks });
			order.push("ensure");
			return result;
		},
	} as Parameters<typeof installLayoutPreAction>[1]);
	return { program, ran, ensured, order, result };
}

const run = (program: Command, argv: string[]) => program.parseAsync(argv, { from: "user" });

describe("shouldSkip", () => {
	test("matches a subcommand by its path below the program name", () => {
		const root = stub(SKILLS_TREE, []);

		expect(shouldSkip(leaf(root, "hooks run"), SKILLS_SKIP)).toBe(true);
		expect(shouldSkip(leaf(root, "spec slugify"), SKILLS_SKIP)).toBe(false);
		expect(shouldSkip(leaf(root, "doctor"), SKILLS_SKIP)).toBe(false);
	});

	test("does not skip a command that only shares the leaf name of a skipped one", () => {
		const root = stub(["hooks run", "jobs run"], []);

		expect(shouldSkip(leaf(root, "jobs run"), SKILLS_SKIP)).toBe(false);
	});

	test("matches a top-level command", () => {
		const root = stub(DAEMON_TREE, []);

		expect(shouldSkip(leaf(root, "status"), DAEMON_SKIP)).toBe(true);
		expect(shouldSkip(leaf(root, "serve"), DAEMON_SKIP)).toBe(false);
	});
});

describe("installLayoutPreAction skip sets", () => {
	test.each([
		["hooks run", ["hooks", "run", "x"], SKILLS_TREE, SKILLS_SKIP],
		["phone listen", ["phone", "listen"], AGENT_TREE, AGENT_SKIP],
		["status", ["status"], DAEMON_TREE, DAEMON_SKIP],
	] as const)("%s returns before ensure is called", async (_name, argv, tree, skip) => {
		const { program, ensured, ran } = wire(tree, skip);

		await run(program, [...argv]);

		expect(ensured).toHaveLength(0);
		expect(ran).toHaveLength(1);
	});

	test.each([
		["spec slugify", ["spec", "slugify", "x"], SKILLS_TREE, SKILLS_SKIP],
		["doctor", ["doctor"], SKILLS_TREE, SKILLS_SKIP],
		["clean", ["clean"], SKILLS_TREE, SKILLS_SKIP],
		["install", ["install"], SKILLS_TREE, SKILLS_SKIP],
		["memory search", ["memory", "search", "x"], AGENT_TREE, AGENT_SKIP],
		["phone status", ["phone", "status"], AGENT_TREE, AGENT_SKIP],
		["serve", ["serve"], DAEMON_TREE, DAEMON_SKIP],
	] as const)("%s records one ensure call", async (_name, argv, tree, skip) => {
		const { program, ensured, ran } = wire(tree, skip);

		await run(program, [...argv]);

		expect(ensured).toHaveLength(1);
		expect(ran).toHaveLength(1);
	});
});

describe("installLayoutPreAction forwarded help", () => {
	const rawProgram = () => {
		const { program, ensured, ran } = wire(["spec"], SKILLS_SKIP);
		const spec = leaf(program, "spec").helpOption(false).allowUnknownOption();
		program.enablePositionalOptions();
		spec.parseOptions = (argv) => ({ operands: [...argv], unknown: [] });
		return { program, ensured, ran };
	};

	test.each([["--help"], ["-h"]])("a raw command given %s first records no ensure call", async (flag) => {
		const { program, ensured, ran } = rawProgram();

		await run(program, ["spec", flag]);

		expect(ensured).toHaveLength(0);
		expect(ran).toEqual(["spec"]);
	});

	test.each([["--help"], ["-h"]])("a raw command given %s after a subcommand records no ensure call", async (flag) => {
		const { program, ensured, ran } = rawProgram();

		await run(program, ["spec", "worktree", "remove", flag]);

		expect(ensured).toHaveLength(0);
		expect(ran).toEqual(["spec"]);
	});

	test("a raw command stops scanning for help at --", async () => {
		const { program, ensured } = rawProgram();

		await run(program, ["spec", "run", "--", "--help"]);

		expect(ensured).toHaveLength(1);
	});

	test("a raw command ignores an argument that only contains a help flag", async () => {
		const { program, ensured } = rawProgram();

		await run(program, ["spec", "run", "--helpful", "x-h"]);

		expect(ensured).toHaveLength(1);
	});

	test("a raw command with an ordinary argument still records one ensure call", async () => {
		const { program, ensured } = rawProgram();

		await run(program, ["spec", "slugify", "x"]);

		expect(ensured).toHaveLength(1);
	});
});

describe("installLayoutPreAction native help", () => {
	test.each([["--help"], ["-h"]])("a native command given %s after -- records one ensure call", async (flag) => {
		const { program, ensured, ran } = wire(SKILLS_TREE, SKILLS_SKIP);

		await run(program, ["spec", "slugify", "--", flag]);

		expect(ensured).toHaveLength(1);
		expect(ran).toEqual(["spec slugify"]);
	});
});

describe("installLayoutPreAction commands that never reach a body", () => {
	const quiet = (program: Command): Command => {
		program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
		program.commands.forEach(quiet);
		return program;
	};

	test.each([
		["a subcommand --help", ["spec", "slugify", "--help"]],
		["the root --help", ["--help"]],
		["an unknown command", ["no-such-command"]],
	] as const)("%s records no ensure call", async (_name, argv) => {
		const { program, ensured, ran } = wire(SKILLS_TREE, SKILLS_SKIP);
		quiet(program);

		await expect(run(program, [...argv])).rejects.toBeInstanceOf(Error);

		expect(ensured).toHaveLength(0);
		expect(ran).toHaveLength(0);
	});

	test("hands the ensure result object to after", async () => {
		const given: LayoutResult[] = [];
		const result = {} as LayoutResult;
		const program = stub(SKILLS_TREE, []);
		installLayoutPreAction(program, {
			skip: SKILLS_SKIP,
			hooksFor: () => ({}),
			ensure: async () => result,
			after: async (_action: Command, received: LayoutResult) => {
				given.push(received);
			},
		} as Parameters<typeof installLayoutPreAction>[1]);

		await run(program, ["doctor"]);

		expect(given).toHaveLength(1);
		expect(given[0]).toBe(result);
	});
});

describe("installLayoutPreAction pipeline", () => {
	test("resolves the memoized DgPaths once and passes it to ensure", async () => {
		const { program, ensured } = wire(SKILLS_TREE, SKILLS_SKIP);

		await run(program, ["spec", "slugify", "x"]);

		expect(ensured[0]?.paths).toBe(resolveDgPaths());
	});

	test("hands the action command to hooksFor and its hooks object to ensure", async () => {
		const hooks: LayoutHooks = {};
		const seen: string[] = [];
		const ensured: LayoutHooks[] = [];
		const program = stub(SKILLS_TREE, []);
		installLayoutPreAction(program, {
			skip: SKILLS_SKIP,
			hooksFor: (action: Command) => {
				seen.push(action.name());
				return hooks;
			},
			ensure: async (_paths: unknown, given: LayoutHooks) => {
				ensured.push(given);
				return {} as LayoutResult;
			},
		} as Parameters<typeof installLayoutPreAction>[1]);

		await run(program, ["spec", "slugify", "x"]);

		expect(seen).toEqual(["slugify"]);
		expect(ensured).toEqual([hooks]);
		expect(ensured[0]).toBe(hooks);
	});

	test("awaits ensure, then after, before the command body runs", async () => {
		const order: string[] = [];
		const program = new Command().name("prog").exitOverride();
		program.command("go").action(() => {
			order.push("action");
		});
		const result = {} as LayoutResult;
		const afterCalls: { action: string; result: unknown }[] = [];
		installLayoutPreAction(program, {
			skip: new Set<string>(),
			hooksFor: () => ({}),
			ensure: async () => {
				await Bun.sleep(20);
				order.push("ensure");
				return result;
			},
			after: async (action: Command, given: unknown) => {
				await Bun.sleep(20);
				order.push("after");
				afterCalls.push({ action: action.name(), result: given });
			},
		} as Parameters<typeof installLayoutPreAction>[1]);

		await run(program, ["go"]);

		expect(order).toEqual(["ensure", "after", "action"]);
		expect(afterCalls).toHaveLength(1);
		expect(afterCalls[0]?.action).toBe("go");
		expect(afterCalls[0]?.result).toBe(result);
	});

	test("does not call after for a skipped command", async () => {
		const { program, order } = wire(SKILLS_TREE, SKILLS_SKIP);

		await run(program, ["hooks", "run", "x"]);

		expect(order).toEqual([]);
	});

	test("works without an after step", async () => {
		const ran: string[] = [];
		const program = stub(SKILLS_TREE, ran);
		installLayoutPreAction(program, {
			skip: SKILLS_SKIP,
			hooksFor: () => ({}),
			ensure: async () => ({}) as LayoutResult,
		} as Parameters<typeof installLayoutPreAction>[1]);

		await run(program, ["doctor"]);

		expect(ran).toEqual(["doctor"]);
	});

	test("lets a DgCliError from ensure reach the caller and never runs the command body", async () => {
		const ran: string[] = [];
		const afterCalls: string[] = [];
		const program = stub(SKILLS_TREE, ran);
		const failure = new DgCliError("lock is held by pid 1");
		installLayoutPreAction(program, {
			skip: SKILLS_SKIP,
			hooksFor: () => ({}),
			ensure: async () => {
				throw failure;
			},
			after: async () => {
				afterCalls.push("after");
			},
		} as Parameters<typeof installLayoutPreAction>[1]);

		await expect(run(program, ["spec", "slugify", "x"])).rejects.toBe(failure);

		expect(ran).toEqual([]);
		expect(afterCalls).toEqual([]);
	});
});

describe("lock failure at the ensure boundary", () => {
	const LOCK_MESSAGE = "/x/.install.lock is held by pid 1; wait for that install to finish or remove the file if it is not running";

	test("reaches the caller as a DgCliError with the lock message and never runs the command body", async () => {
		const home = mkdtempSync(join(tmpdir(), "dg-preaction-lock-"));
		try {
			const paths = resolveDgPaths({ platform: "linux", homeDir: home, env: {} });
			mkdirSync(join(paths.legacyHome, "daemon"), { recursive: true });
			writeFileSync(join(paths.legacyHome, "daemon", "daemon.db"), "db");
			const ran: string[] = [];
			const program = stub(SKILLS_TREE, ran);
			installLayoutPreAction(program, {
				skip: SKILLS_SKIP,
				hooksFor: () => ({
					log: () => {},
					lock: withCliLockError(async () => {
						throw new Error(LOCK_MESSAGE);
					}),
				}),
				ensure: (_paths, hooks) => ensureLayout(paths, hooks),
			});

			const failure = await run(program, ["spec", "slugify", "x"]).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(failure).toBeInstanceOf(DgCliError);
			expect((failure as DgCliError).message).toBe(LOCK_MESSAGE);
			expect((failure as DgCliError).exitCode).toBe(1);
			expect(ran).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("passes an error thrown by the guarded body through unchanged", async () => {
		const bodyFailure = new Error("copy failed");
		const lock = withCliLockError(async (_root, fn) => fn());

		await expect(lock("/x", async () => Promise.reject(bodyFailure))).rejects.toBe(bodyFailure);
	});
});
