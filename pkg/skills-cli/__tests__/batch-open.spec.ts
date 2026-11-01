import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	MARKER_BATCH_KEY,
	MARKER_KEY,
	MARKER_POS_KEY,
} from "../src/utils/marker";
import { type ExtCommandWorld, extCommandWorld } from "./ext-command-harness";

const GROUP_NOTE = "batch-open: --group needs --ext; opening plain tabs";
const A = "https://example.test/a";
const B = "https://example.test/b";

describe("batch-open on a CLI-only install", () => {
	let world: ExtCommandWorld;
	beforeEach(() => {
		world = extCommandWorld({ cliOnly: true });
	});
	afterEach(() => world.cleanup());

	test("opens one plain tab and exits 0 without --ext", async () => {
		const run = await world.run(["batch-open", A]);
		expect(run.error).toBeNull();
		expect(run.exitCode).toBe(0);
		expect(run.opened).toEqual([A]);
		expect(run.opened[0]).not.toContain(MARKER_KEY);
		expect(run.stdout).toContain("1 tab(s) opened");
	});

	test("refuses --ext with the extension-required message", async () => {
		const run = await world.run(["batch-open", "--ext", A]);
		expect(run.error).toStartWith(
			"dg-skills batch-open needs the dg-ai-extension, but this is a CLI-only install.",
		);
		expect(run.opened).toEqual([]);
	});
});

describe("batch-open on a full install", () => {
	let world: ExtCommandWorld;
	beforeEach(() => {
		world = extCommandWorld({ cliOnly: false });
	});
	afterEach(() => world.cleanup());

	test("opens each ref unmarked and prints the plain summary without --ext", async () => {
		const run = await world.run(["batch-open", A, B]);
		expect(run.opened).toEqual([A, B]);
		expect(run.stdout).toContain("2 tab(s) opened");
		expect(run.stdout).not.toContain("dg-ai-extension will group");
		expect(run.stderr).not.toContain(GROUP_NOTE);
	});

	test("--print without --ext prints two unmarked URLs and opens nothing", async () => {
		const run = await world.run(["batch-open", "--print", A, B]);
		expect(
			run.stdout.split("\n").filter((l) => l.startsWith("https://")),
		).toEqual([A, B]);
		expect(run.opened).toEqual([]);
		expect(run.stderr).not.toContain(GROUP_NOTE);
	});

	test("--group without --ext prints the one stderr line and still opens plain tabs", async () => {
		const run = await world.run(["batch-open", "--group", "R", A]);
		expect(run.exitCode).toBe(0);
		expect(run.stderr.split("\n").filter((l) => l === GROUP_NOTE)).toHaveLength(
			1,
		);
		expect(run.opened).toEqual([A]);
	});

	test("--print --group without --ext prints plain URLs after the stderr line", async () => {
		const run = await world.run([
			"batch-open",
			"--print",
			"--group",
			"R",
			A,
			B,
		]);
		expect(run.stderr).toContain(GROUP_NOTE);
		expect(
			run.stdout.split("\n").filter((l) => l.startsWith("https://")),
		).toEqual([A, B]);
	});

	test("--ext --print --group marks the URL with group, position and batch", async () => {
		const run = await world.run([
			"batch-open",
			"--ext",
			"--print",
			"--group",
			"R",
			A,
		]);
		const printed = run.stdout.split("\n").find((l) => l.startsWith(A));
		expect(printed).toBeDefined();
		const fragment = printed?.split("#")[1] ?? "";
		expect(fragment).toContain(`${MARKER_KEY}=R`);
		expect(fragment).toContain(`${MARKER_POS_KEY}=0`);
		expect(fragment).toContain(`${MARKER_BATCH_KEY}=`);
		expect(run.stderr).not.toContain(GROUP_NOTE);
	});

	test("--ext without --print opens marked tabs with the extension grouping line", async () => {
		const run = await world.run([
			"batch-open",
			"--ext",
			"--group",
			"Reviews",
			A,
			B,
		]);
		expect(run.opened).toHaveLength(2);
		for (const [i, url] of run.opened.entries()) {
			expect(url).toContain(`${MARKER_KEY}=Reviews`);
			expect(url).toContain(`${MARKER_POS_KEY}=${i}`);
		}
		expect(run.stdout).toContain(
			'dg-ai-extension will group them into "Reviews"',
		);
	});
});
