import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
	FAKE,
	FAKE_VALUES,
	type SniffJson,
	secretBearingTree,
	sniffWorld,
} from "./sniff-fixtures";

import { CLI_ENTRY } from "./module-call";

const world = sniffWorld();
afterAll(() => world.cleanup());

function parse(stdout: string): SniffJson {
	return JSON.parse(stdout) as SniffJson;
}

function names(report: SniffJson, type: string): string[] {
	return report.requirements
		.filter((row) => row.type === type)
		.map((row) => row.name)
		.sort();
}

describe("dg-skills sniff inventory output", () => {
	test("stdout and stderr carry no env, Terraform, Docker or CI secret value", async () => {
		const root = world.repo(secretBearingTree());
		const run = await world.sniff([root], world.tmp("sniff-cwd-"));
		expect(run.exitCode).toBe(0);
		const everything = `${run.stdout}\n${run.stderr}`;
		for (const value of FAKE_VALUES)
			expect([value, everything.includes(value)]).toEqual([value, false]);
	});

	test("reduces registry feeds to the host with no userinfo", async () => {
		const root = world.repo(secretBearingTree());
		const report = parse((await world.sniff([root], root)).stdout);
		expect(names(report, "REGISTRY")).toEqual(
			expect.arrayContaining(["npm.example.test", "nuget.example.test"]),
		);
	});

	test("lists secret and config names from every surface with the right type", async () => {
		const root = world.repo(secretBearingTree());
		const report = parse((await world.sniff([root], root)).stdout);
		expect(names(report, "SECRET")).toEqual(
			[
				"SF_PRIVATE_KEY",
				"API_TOKEN",
				"DB_PASSWORD",
				"SERVICE_TOKEN",
				"DEPLOY_TOKEN",
				"REGISTRY_PASSWORD",
				"api",
			].sort(),
		);
		expect(names(report, "CONFIG")).toEqual(
			["DB_HOST", "STRAY_FLAG", "APP_REGION", "APP_MODE"].sort(),
		);
	});

	test("emits no value field on any secret or config row", async () => {
		const root = world.repo(secretBearingTree());
		const report = parse((await world.sniff([root], root)).stdout);
		const sensitive = report.requirements.filter(
			(row) => row.type === "SECRET" || row.type === "CONFIG",
		);
		expect(sensitive.length).toBeGreaterThan(0);
		for (const row of sensitive)
			expect([row.name, Object.hasOwn(row, "value")]).toEqual([
				row.name,
				false,
			]);
	});

	test("cites repo-relative locations and never an absolute or home path", async () => {
		const root = world.repo(secretBearingTree());
		const run = await world.sniff([root], world.tmp("sniff-cwd-"));
		const report = parse(run.stdout);
		for (const row of report.requirements) {
			expect(row.where.startsWith("/")).toBe(false);
			expect(row.where).toMatch(/:\d+$/);
		}
		expect(run.stdout.includes(root)).toBe(false);
		expect(run.stdout.includes(world.home)).toBe(false);
	});

	test("prints the report as two-space JSON ending in one newline and nothing on stderr", async () => {
		const root = world.repo(secretBearingTree());
		const run = await world.sniff([root], root);
		const report = parse(run.stdout);
		expect(run.stdout).toBe(`${JSON.stringify(report, null, 2)}\n`);
		expect(run.stderr).toBe("");
		expect(report.total).toBe(report.requirements.length);
		expect(report.gaps).toBe(
			report.requirements.filter((row) => row.gaps.length > 0).length,
		);
		const counted = Object.values(report.counts).reduce((a, b) => a + b, 0);
		expect(counted).toBe(report.total);
	});

	test("floats the undocumented key to the top and still exits 0", async () => {
		const root = world.repo(secretBearingTree());
		const run = await world.sniff([root], root);
		const report = parse(run.stdout);
		expect(run.exitCode).toBe(0);
		expect(report.gaps).toBeGreaterThan(0);
		expect(report.requirements[0]?.name).toBe("STRAY_FLAG");
		expect(report.requirements[0]?.gaps[0]?.kind).toBe("undocumented");
	});

	test("scans the working directory when no path is given", async () => {
		const root = world.repo(secretBearingTree());
		const report = parse((await world.sniff([], root)).stdout);
		expect(report.repo).toBe(basename(root));
		expect(names(report, "SECRET")).toContain("SF_PRIVATE_KEY");
	});

	test("names the scanned directory for a relative path argument", async () => {
		const root = world.repo(secretBearingTree());
		const report = parse(
			(await world.sniff([basename(root)], join(root, ".."))).stdout,
		);
		expect(report.repo).toBe(basename(root));
	});

	test("names the scanned directory, never .., when the path is the parent", async () => {
		const root = world.repo(secretBearingTree());
		const inner = join(root, "inner");
		mkdirSync(inner);
		const report = parse((await world.sniff([".."], inner)).stdout);
		expect(report.repo).toBe(basename(root));
		expect(report.requirements.length).toBeGreaterThan(0);
	});

	test("ignores arguments after the path", async () => {
		const root = world.repo(secretBearingTree());
		const single = await world.sniff([root], root);
		const extra = await world.sniff([root, "--gaps", "ignored"], root);
		expect(extra.exitCode).toBe(0);
		expect(extra.stdout).toBe(single.stdout);
	});

	test("skips the nested checkout directories a worktree leaves behind", async () => {
		const root = world.repo({
			...secretBearingTree(),
			".claude/worktrees/copy/.env": "NESTED_ONLY_TOKEN=x\n",
			"node_modules/pkg/.env": "MODULE_ONLY_TOKEN=x\n",
		});
		const run = await world.sniff([root], root);
		expect(run.stdout).not.toContain("NESTED_ONLY_TOKEN");
		expect(run.stdout).not.toContain("MODULE_ONLY_TOKEN");
	});
});

describe("dg-skills sniff empty inventory", () => {
	test("an empty directory reports zero items on stdout with exit 0", async () => {
		const root = world.tree({});
		const run = await world.sniff([root], world.tmp("sniff-cwd-"));
		expect(run.exitCode).toBe(0);
		expect(run.stderr).toBe("");
		expect(parse(run.stdout)).toEqual({
			repo: basename(root),
			total: 0,
			gaps: 0,
			counts: {},
			requirements: [],
		});
	});

	test("a repo with no recognizable surface reports zero items", async () => {
		const root = world.repo({ "README.md": "# nothing to provision\n" });
		const report = parse((await world.sniff([root], root)).stdout);
		expect(report.total).toBe(0);
		expect(report.requirements).toEqual([]);
	});
});

describe("dg-skills sniff root errors keep the legacy exit status 1", () => {
	test("a missing path exits 1 with the legacy message and an empty stdout", async () => {
		const cwd = world.tmp("sniff-cwd-");
		const missing = join(cwd, "does-not-exist");
		const run = await world.sniff([missing], cwd);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(`sniff: no such path: ${missing}\n`);
	});

	test("a relative missing path is echoed as typed", async () => {
		const cwd = world.tmp("sniff-cwd-");
		const run = await world.sniff(["missing-dir"], cwd);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toBe("sniff: no such path: missing-dir\n");
	});

	test("a file path exits 1 with the not-a-directory message", async () => {
		const root = world.tree({ "notes.txt": "hello\n" });
		const file = join(root, "notes.txt");
		const run = await world.sniff([file], root);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toBe(`sniff: not a directory: ${file}\n`);
	});

	test("root errors reveal no secret value from the surrounding tree", async () => {
		const root = world.repo(secretBearingTree());
		const run = await world.sniff([join(root, ".env")], root);
		expect(run.exitCode).toBe(1);
		for (const value of FAKE_VALUES)
			expect(`${run.stdout}${run.stderr}`.includes(value)).toBe(false);
	});
});

describe("dg-skills sniff help", () => {
	test("--help exits 0, prints usage and scans nothing", async () => {
		const root = world.repo(secretBearingTree());
		const run = await world.sniff(["--help"], root);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("sniff");
		expect(run.stdout.toLowerCase()).toContain("usage");
		expect(() => JSON.parse(run.stdout)).toThrow();
		for (const name of ["SF_PRIVATE_KEY", "DEPLOY_TOKEN"])
			expect(run.stdout).not.toContain(name);
		for (const value of FAKE_VALUES) expect(run.stdout).not.toContain(value);
	});

	test("--help works with no readable HOME and from a non-repo directory", async () => {
		const run = await world.sniff(["--help"], world.tmp("sniff-cwd-"), {
			HOME: join(world.home, "absent"),
		});
		expect(run.exitCode).toBe(0);
	});
});

describe("sniff module imports", () => {
	async function exportsOf(path: string) {
		const proc = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import(${JSON.stringify(path)}).then((m) => process.stdout.write(JSON.stringify(Object.keys(m).sort())))`,
			],
			{ stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: world.home },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { names: JSON.parse(stdout || "[]") as string[], stderr, exitCode };
	}

	test("the domain module imports without scanning, printing or exiting", async () => {
		const loaded = await exportsOf(join(CLI_ENTRY, "../sniff/index.ts"));
		expect(loaded.exitCode).toBe(0);
		expect(loaded.stderr).toBe("");
		for (const name of ["sniff", "buildReport", "walkFiles", "classifyEnvKey"])
			expect(loaded.names).toContain(name);
	});

	test("the command module exports registerSniff and imports inertly", async () => {
		const loaded = await exportsOf(join(CLI_ENTRY, "../commands/sniff.ts"));
		expect(loaded.exitCode).toBe(0);
		expect(loaded.stderr).toBe("");
		expect(loaded.names).toContain("registerSniff");
	});
});

describe("fake value fixtures", () => {
	test("every planted value is unique so a leak names its source", () => {
		expect(new Set(FAKE_VALUES).size).toBe(Object.keys(FAKE).length);
	});
});
