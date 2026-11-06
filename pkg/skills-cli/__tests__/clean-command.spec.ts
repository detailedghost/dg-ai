import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { installLayoutPreAction } from "@dg/common/node/layout-preaction";
import { hooksFor, main } from "../src/main";
import { registerAll } from "../src/register-all";

const SRC = join(import.meta.dir, "../src");
const CLEAN_DESCRIPTION =
	"remove the leftovers of the move from ~/.dg: empty copies that were set aside, and an empty ~/.dg";

const realOut = process.stdout.write;
const realErr = process.stderr.write;
const realExitCode = process.exitCode;
let out: string[];
let err: string[];

beforeEach(() => {
	out = [];
	err = [];
	process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
	process.exitCode = 0;
});

afterEach(() => {
	process.stdout.write = realOut;
	process.stderr.write = realErr;
	process.exitCode = realExitCode ?? 0;
});

const flat = (parts: string[]): string => parts.join("").replace(/\s+/g, " ");

function staticImports(source: string): string[] {
	return [...source.matchAll(/^import\s+(?!type\b)(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gm)].map((match) => match[1] ?? "");
}

describe("dg-skills clean command", () => {
	test("is listed in the root help with its description and is not hidden", async () => {
		expect(await main(["--help"])).toBe(0);

		expect(flat(out)).toMatch(/\bclean\b/);
		expect(flat(out)).toContain("remove the leftovers of the move from ~/.dg");
	});

	test("prints its description and exits 0 for clean --help", async () => {
		expect(await main(["clean", "--help"])).toBe(0);

		expect(flat(out)).toContain(CLEAN_DESCRIPTION);
	});

	test("rejects an extra argument with commander's error", async () => {
		const code = await main(["clean", "extra"]);

		expect(code).not.toBe(0);
		expect(flat(err)).toContain("too many arguments");
	});

	test("rejects an unknown option", async () => {
		expect(await main(["clean", "--force"])).not.toBe(0);
	});
});

const sentinel = new Error("ensure reached");

function wireRegistered() {
	const ensured: Array<{ hooks: unknown }> = [];
	const program = new Command().name("dg-skills").exitOverride();
	program.enablePositionalOptions();
	registerAll(program);
	installLayoutPreAction(program, {
		skip: new Set(["hooks run"]),
		hooksFor: (action) => hooksFor(action.name()),
		ensure: async (_paths, hooks) => {
			ensured.push({ hooks });
			throw sentinel;
		},
	});
	return { program, ensured };
}

describe("dg-skills clean preAction registration", () => {
	test("records one ensure call for clean and the clean body never runs when ensure fails", async () => {
		const { program, ensured } = wireRegistered();

		await expect(program.parseAsync(["clean"], { from: "user" })).rejects.toBe(sentinel);

		expect(ensured).toHaveLength(1);
		expect(err).toEqual([]);
	});

	test("records no ensure call for a rejected extra argument", async () => {
		const { program, ensured } = wireRegistered();

		await expect(program.parseAsync(["clean", "extra"], { from: "user" })).rejects.toMatchObject({
			code: "commander.excessArguments",
		});

		expect(ensured).toHaveLength(0);
	});

	test("composes no owner hooks for clean", () => {
		expect(hooksFor("clean")).toEqual({});
	});
});

const transpiler = new Bun.Transpiler({ loader: "ts" });

function topLevelRelativeImports(file: string): string[] {
	return transpiler
		.scanImports(readFileSync(file, "utf8"))
		.filter((found) => found.kind === "import-statement" && found.path.startsWith("."))
		.map((found) => Bun.resolveSync(found.path, join(file, "..")));
}

function reachableFrom(entry: string): Set<string> {
	const seen = new Set<string>();
	const visit = (file: string): void => {
		if (seen.has(file)) return;
		seen.add(file);
		topLevelRelativeImports(file).forEach(visit);
	};
	visit(entry);
	return seen;
}

describe("clean command module weight", () => {
	test("no module reachable from register-all through top-level imports is install/clean", () => {
		const reachable = [...reachableFrom(join(SRC, "register-all.ts"))];

		expect(reachable).toContain(join(SRC, "commands/clean.ts"));
		expect(reachable.filter((file) => file.endsWith(join("install", "clean.ts")))).toEqual([]);
	});

	test("statically imports only commander", () => {
		const specifiers = staticImports(readFileSync(join(SRC, "commands/clean.ts"), "utf8"));

		expect(specifiers.every((specifier) => specifier === "commander")).toBe(true);
	});

	test("register-all does not statically import install/clean", () => {
		const specifiers = staticImports(readFileSync(join(SRC, "register-all.ts"), "utf8"));

		expect(specifiers.some((specifier) => specifier.includes("install/clean"))).toBe(false);
		expect(specifiers).toContain("./commands/clean");
	});
});

describe("install/clean source", () => {
	const source = (): string => readFileSync(join(SRC, "install/clean.ts"), "utf8");

	test("names no launcher literally", () => {
		expect(source()).not.toMatch(/"dg-skills"|"dg-agent"|"dg-daemon"/);
	});

	test("imports PROGRAMS from ./shims", () => {
		expect(source()).toMatch(/import\s*\{[^}]*\bPROGRAMS\b[^}]*\}\s*from\s*["']\.\/shims["']/);
	});
});
