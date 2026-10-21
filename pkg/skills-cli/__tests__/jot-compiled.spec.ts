import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { buildCompiledBinary } from "./compiled-binary";
import { checkpointBody, ID_A, jotWorld, section } from "./jot-fixtures";

setDefaultTimeout(60_000);

const command: string[] = [];
const world = jotWorld(command);
let cwd: string;
let only: Record<string, string>;

beforeAll(() => {
	command.push(buildCompiledBinary());
}, 240_000);

beforeEach(() => {
	const base = world.tmp("jot-compiled-");
	const bin = join(base, "git only");
	mkdirSync(bin, { recursive: true });
	const git = Bun.which("git");
	if (!git) throw new Error("git is required");
	symlinkSync(git, join(bin, "git"));
	only = { PATH: bin };
	cwd = world.repo().main;
});

afterEach(() => world.reset());
afterAll(() => world.cleanup());

describe("compiled dg-skills jot from an external cwd", () => {
	test("add, ls, read, kind and done round-trip a note with only git on PATH", async () => {
		const added = await world.jot(["add"], cwd, "# compiled note\n\nbody\n", only);
		expect(added.exitCode).toBe(0);
		const file = added.stdout.trim();
		expect(file.startsWith(join(world.scratch, "jot"))).toBe(true);
		const name = file.split("/").pop()?.replace(/\.md$/, "") ?? "";
		const listed = await world.jot(["ls"], cwd, undefined, only);
		expect(listed.stdout.trim().split("\t")).toEqual(["note", "0m", name, "compiled note"]);
		expect((await world.jot(["read", name], cwd, undefined, only)).stdout).toBe("# compiled note\n\nbody\n");
		expect((await world.jot(["kind", name], cwd, undefined, only)).stdout).toBe("note\n");
		expect((await world.jot(["done", name], cwd, undefined, only)).stdout).toBe(`removed ${file}\n`);
		expect(existsSync(file)).toBe(false);
	});

	test("a split save keeps its parts readable by number", async () => {
		const body = `# Handoff\n\n${section("Context", 1500)}${section("References", 1500)}`;
		const folder = (await world.jot(["add", "-s"], cwd, body, only)).stdout.trim();
		const name = folder.split("/").pop() ?? "";
		const part = await world.jot(["read", `${name}/1`], cwd, undefined, only);
		expect(part.stdout.startsWith("## Context\n")).toBe(true);
	});

	test("kick, kick-list and kick-take use HOME/doc/checkpoint.md", async () => {
		expect((await world.jot(["kick"], cwd, checkpointBody(ID_A), only)).stdout).toBe(`${ID_A}\n`);
		const target = join(world.home, "doc", "checkpoint.md");
		expect(readFileSync(target, "utf8")).toContain(`## ${ID_A}`);
		expect((await world.jot(["kick-list"], cwd, undefined, only)).stdout).toBe(`${ID_A}\tstate of play\n`);
		const taken = await world.jot(["kick-take", ID_A], cwd, undefined, only);
		expect(taken.stdout).toBe(checkpointBody(ID_A));
		expect(existsSync(target)).toBe(false);
	});

	test("an ambiguous take exits 1 with the rows on stdout", async () => {
		await world.jot(["kick"], cwd, checkpointBody(ID_A, "same work"), only);
		await world.jot(["kick"], cwd, checkpointBody("2026-10-13 1501 — other — second", "same work"), only);
		const run = await world.jot(["kick-take", "same work"], cwd, undefined, only);
		expect(run.exitCode).toBe(1);
		expect(run.stdout.trim().split("\n")).toHaveLength(2);
	});
});
