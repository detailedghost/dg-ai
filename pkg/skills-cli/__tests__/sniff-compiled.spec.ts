import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { buildCompiledBinary } from "./compiled-binary";
import {
	FAKE_VALUES,
	type SniffJson,
	secretBearingTree,
	sniffWorld,
} from "./sniff-fixtures";

setDefaultTimeout(60_000);

const command: string[] = [];
const world = sniffWorld(command);
let cwd: string;
let emptyPath: Record<string, string>;

beforeAll(() => {
	const base = world.tmp("sniff-compiled-");
	command.push(buildCompiledBinary());
	const bin = join(base, "empty bin");
	mkdirSync(bin, { recursive: true });
	emptyPath = { PATH: bin };
	cwd = world.tree({}, "sniff-external-cwd-");
}, 240_000);

afterAll(() => world.cleanup());

describe("compiled dg-skills sniff from an external cwd", () => {
	test("inventories a secret-bearing tree with nothing on PATH and leaks no value", async () => {
		const root = world.repo(secretBearingTree());
		const run = await world.sniff([root], cwd, emptyPath);
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toBe("");
		const report = JSON.parse(run.stdout) as SniffJson;
		expect(report.repo).toBe(basename(root));
		expect(report.requirements.map((row) => row.name)).toContain(
			"SF_PRIVATE_KEY",
		);
		for (const value of FAKE_VALUES)
			expect(`${run.stdout}${run.stderr}`.includes(value)).toBe(false);
	});

	test("a missing path exits 1 with the legacy message", async () => {
		const missing = join(cwd, "missing");
		const run = await world.sniff([missing], cwd, emptyPath);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(`sniff: no such path: ${missing}\n`);
	});

	test("an empty directory reports zero items", async () => {
		const run = await world.sniff([world.tree({})], cwd, emptyPath);
		expect(run.exitCode).toBe(0);
		const report = JSON.parse(run.stdout) as SniffJson;
		expect([report.total, report.gaps, report.requirements]).toEqual([
			0,
			0,
			[],
		]);
	});

	test("--help exits 0 without scanning the working directory", async () => {
		const root = world.repo(secretBearingTree());
		const run = await world.sniff(["--help"], root, emptyPath);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).not.toContain("SF_PRIVATE_KEY");
	});
});
