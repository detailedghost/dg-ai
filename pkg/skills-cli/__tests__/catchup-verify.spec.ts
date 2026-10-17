import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolateCliTests, readCalls } from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { scratchFixtures } from "./git-repo-fixtures";

const VERIFY = join(import.meta.dir, "../src/catchup/verify.ts");
const BUN = process.execPath;
const fixtures = scratchFixtures();
isolateCliTests();
afterEach(() => fixtures.cleanup());

type Call = { tool: string; args: string[]; cwd: string };
let tools: string;
let log: string;
beforeEach(() => {
	tools = fixtures.tmp("dg catchup verifier tools ");
	log = join(tools, "calls.jsonl");
	for (const name of ["bash", "find"]) {
		const path = Bun.which(name, { PATH: "/usr/bin:/bin" });
		if (!path) throw new Error(`Missing fixture utility ${name}`);
		symlinkSync(path, join(tools, name));
	}
	for (const tool of ["bun", "npm", "dotnet", "uv", "go", "dbt"]) {
		writeFakeCli(
			tools,
			tool,
			`#!${BUN}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool:${JSON.stringify(tool)}, args, cwd:process.cwd()}) + "\\n");
console.log(${JSON.stringify(`${tool} stdout`)});
console.error(${JSON.stringify(`${tool} stderr`)});
process.exit(process.env.FAIL_TOOL === ${JSON.stringify(tool)} && (!process.env.FAIL_ARG || process.env.FAIL_ARG === args[0]) ? 7 : 0);
`,
		);
	}
});
function calls(): Call[] {
	return readCalls(log).map((line) => JSON.parse(line));
}
function put(cwd: string, file: string, text = "fixture\n") {
	mkdirSync(dirname(join(cwd, file)), { recursive: true });
	writeFileSync(join(cwd, file), text);
}
function project(files: Record<string, string> = {}) {
	const root = fixtures.tmp("dg verifier project ");
	fixtures.git(["init", "-q", "-b", "main"], root);
	for (const [file, text] of Object.entries(files)) put(root, file, text);
	return root;
}
function runVerify(
	cwd: string,
	env: Record<string, string> = {},
	explicitCwd?: string,
) {
	const proc = Bun.spawnSync(
		[
			BUN,
			"-e",
			`const { verifyBuild } = await import(${JSON.stringify(VERIFY)}); process.exitCode = await verifyBuild(${explicitCwd === undefined ? "" : JSON.stringify(explicitCwd)});`,
		],
		{ cwd, env: { ...process.env, ...env }, stdin: "ignore" },
	);
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}
const nodeProject = {
	"package.json": '{"scripts":{"build":"ignored","test":"ignored"}}\n',
};
const mixedProject = {
	...nodeProject,
	"app.sln": "",
	"pyproject.toml": "[project]\nname = 'fixture'\n",
	"tests/test_unit.py": "",
	"go.mod": "module example.invalid/fixture\n",
	"warehouse/dbt_project.yml": "",
};

describe("verifyBuild", () => {
	test("imports without spawning tools, reading project files, or creating state", () => {
		const cwd = fixtures.tmp("dg verifier import ");
		const proc = Bun.spawnSync(
			[
				BUN,
				"-e",
				`
const fs = require("node:fs");
const unexpected = () => { throw new Error("unexpected import side effect"); };
Bun.spawn = unexpected; Bun.spawnSync = unexpected; Bun.file = unexpected; Bun.write = unexpected;
for (const name of ["readFileSync", "writeFileSync", "mkdirSync", "readdirSync"]) fs[name] = unexpected;
await import(${JSON.stringify(VERIFY)});
console.log("loaded");
`,
			],
			{ cwd, env: { ...process.env } },
		);
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("loaded\n");
		expect(proc.stderr.toString()).toBe("");
		expect(calls()).toEqual([]);
	});

	test("succeeds with a root-specific skip when no project type is recognized", () => {
		const root = project();
		const result = runVerify(root);
		expect(result).toEqual({
			exitCode: 0,
			stdout: `==> No recognized project type found at ${root}. Skipping build verification.\n`,
			stderr: "",
		});
		expect(calls()).toEqual([]);
	});

	test("falls back to caller cwd outside Git and still verifies detected projects", () => {
		const root = fixtures.tmp("dg verifier outside git ");
		put(root, "go.mod", "module example.invalid/fixture\n");
		const result = runVerify(root);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(calls()).toEqual([
			{ tool: "go", args: ["build", "./..."], cwd: root },
			{ tool: "go", args: ["test", "./..."], cwd: root },
		]);
	});

	test("preserves a repository root ending in a literal trailing space", () => {
		const root = join(
			fixtures.tmp("dg verifier trailing space parent "),
			"repo ",
		);
		mkdirSync(root);
		fixtures.git(["init", "-q", "-b", "main"], root);
		put(root, "go.mod", "module example.invalid/trailing-space\n");
		const result = runVerify(root);
		expect(result.exitCode).toBe(0);
		expect(calls()).toEqual([
			{ tool: "go", args: ["build", "./..."], cwd: root },
			{ tool: "go", args: ["test", "./..."], cwd: root },
		]);
		expect(result.stdout).not.toContain("No recognized project type");
		expect(result.stderr).toBe("");
	});

	test.each(["app.sln", "app.csproj", "one/two/app.csproj"])(
		"detects .NET at %s and runs build then unit tests in caller cwd",
		(file) => {
			const root = project({ [file]: "" });
			const cwd = join(root, "nested caller");
			mkdirSync(cwd);
			const result = runVerify(cwd);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain("[dotnet] Building");
			expect(calls()).toEqual([
				{ tool: "dotnet", args: ["build"], cwd },
				{
					tool: "dotnet",
					args: ["test", "--filter", "Category=Unit", "--verbosity", "minimal"],
					cwd,
				},
			]);
		},
	);

	test.each(["one/two/three/app.csproj", "one/app.sln"])(
		"ignores .NET outside its supported detection depth at %s",
		(file) => {
			const root = project({ [file]: "" });
			const result = runVerify(root);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("No recognized project type");
			expect(calls()).toEqual([]);
		},
	);

	test.each(["bun", "npm"])(
		"uses %s for Node and merges both child streams onto stdout",
		(runner) => {
			if (runner === "npm") rmSync(join(tools, "bun"));
			const root = project(nodeProject);
			const cwd = join(root, "nested caller");
			mkdirSync(cwd);
			const result = runVerify(cwd);
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain(
				`[node/${runner}] Building...\n${runner} stdout\n${runner} stderr\n`,
			);
			expect(result.stdout).toContain(
				`[node/${runner}] Running tests...\n${runner} stdout\n${runner} stderr\n`,
			);
			expect(calls()).toEqual([
				{ tool: runner, args: ["run", "build"], cwd },
				{ tool: runner, args: ["test"], cwd },
			]);
		},
	);

	test.each([
		['{"description":"build and test"}', []],
		['{"build":false,"test":false}', [["run", "build"], ["test"]]],
		['{"scripts":{"prebuild":"ignored","testing":"ignored"}}', []],
		['{"scripts":{"test":"ignored"}}', [["test"]]],
		['{"scripts":{"build":"ignored"}}', [["run", "build"]]],
	] as [string, string[][]][])(
		"uses literal quoted Node names in %s",
		(manifest, expectedArgs) => {
			const root = project({ "package.json": manifest });
			const result = runVerify(root);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).not.toContain("No recognized project type");
			expect(calls().map((call) => call.args)).toEqual(expectedArgs);
		},
	);

	test.each([
		"test_top.py",
		"one/two/unit_test.py",
		"one/two/three/test_deep.py",
		"none",
	])("syncs Python and detects tests within depth three for %s", (file) => {
		const root = project({
			"pyproject.toml": "[project]\nname = 'fixture'\n",
			...(file === "none" ? {} : { [file]: "" }),
		});
		const cwd = join(root, "nested caller");
		mkdirSync(cwd);
		const result = runVerify(cwd);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const expected: Call[] = [
			{ tool: "uv", args: ["sync", "--project", root, "--all-groups"], cwd },
		];
		if (file !== "none" && !file.includes("three"))
			expected.push({
				tool: "uv",
				args: ["run", "--project", root, "--all-groups", "pytest"],
				cwd,
			});
		expect(calls()).toEqual(expected);
	});

	test.each([
		"[tool.uv]\n",
		" [project]\n",
		"[project.optional-dependencies]\n",
	])("does not treat %j as the Python project section", (contents) => {
		const root = project({ "pyproject.toml": contents, "test_unit.py": "" });
		const result = runVerify(root);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("No recognized project type");
		expect(calls()).toEqual([]);
	});

	test.each([
		"dbt_project.yml",
		"one/two/dbt_project.yml",
		"one/two/three/dbt_project.yml",
	])("skips dbt without any warehouse calls at %s", (file) => {
		const root = project({ [file]: "" });
		const result = runVerify(root);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(calls()).toEqual([]);
		if (file.includes("three"))
			expect(result.stdout).toContain("No recognized project type");
		else
			expect(result.stdout).toBe(
				"==> [dbt] Detected but skipping (needs warehouse credentials).\n",
			);
	});

	test("detects at Git root while preserving caller cwd for .NET/Node/uv and root cwd for Go", () => {
		const root = project(mixedProject);
		const cwd = join(root, "caller with spaces");
		mkdirSync(cwd);
		const result = runVerify(cwd);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(calls()).toEqual([
			{ tool: "dotnet", args: ["build"], cwd },
			{
				tool: "dotnet",
				args: ["test", "--filter", "Category=Unit", "--verbosity", "minimal"],
				cwd,
			},
			{ tool: "bun", args: ["run", "build"], cwd },
			{ tool: "bun", args: ["test"], cwd },
			{ tool: "uv", args: ["sync", "--project", root, "--all-groups"], cwd },
			{
				tool: "uv",
				args: ["run", "--project", root, "--all-groups", "pytest"],
				cwd,
			},
			{ tool: "go", args: ["build", "./..."], cwd: root },
			{ tool: "go", args: ["test", "./..."], cwd: root },
		]);
		const markers = [
			"[dotnet] Building",
			"[node/bun] Building",
			"[python/uv] Syncing",
			"[go] Building",
			"[dbt] Detected",
		];
		const positions = markers.map((marker) => result.stdout.indexOf(marker));
		expect(
			positions.every(
				(position, index) =>
					position >= 0 && (index === 0 || position > positions[index - 1]!),
			),
		).toBe(true);
	});

	test("supports an explicit cwd independently of the subprocess working directory", () => {
		const root = project(mixedProject);
		const cwd = join(root, "explicit caller");
		mkdirSync(cwd);
		const outside = fixtures.tmp("dg verifier different process cwd ");
		const result = runVerify(outside, {}, cwd);
		expect(result.exitCode).toBe(0);
		expect(calls().map((call) => [call.tool, call.cwd])).toEqual([
			["dotnet", cwd],
			["dotnet", cwd],
			["bun", cwd],
			["bun", cwd],
			["uv", cwd],
			["uv", cwd],
			["go", root],
			["go", root],
		]);
	});

	test.each([
		[
			"dotnet",
			"build",
			"[dotnet] BUILD FAILED.",
			["dotnet:build", "bun:run", "uv:sync", "uv:run", "go:build", "go:test"],
		],
		[
			"dotnet",
			"test",
			"[dotnet] TESTS FAILED.",
			[
				"dotnet:build",
				"dotnet:test",
				"bun:run",
				"uv:sync",
				"uv:run",
				"go:build",
				"go:test",
			],
		],
		[
			"bun",
			"run",
			"[node/bun] BUILD FAILED.",
			[
				"dotnet:build",
				"dotnet:test",
				"bun:run",
				"uv:sync",
				"uv:run",
				"go:build",
				"go:test",
			],
		],
		[
			"bun",
			"test",
			"[node/bun] TESTS FAILED.",
			[
				"dotnet:build",
				"dotnet:test",
				"bun:run",
				"bun:test",
				"uv:sync",
				"uv:run",
				"go:build",
				"go:test",
			],
		],
		[
			"uv",
			"sync",
			"[python/uv] SYNC FAILED.",
			[
				"dotnet:build",
				"dotnet:test",
				"bun:run",
				"bun:test",
				"uv:sync",
				"go:build",
				"go:test",
			],
		],
		[
			"uv",
			"run",
			"[python/uv] TESTS FAILED.",
			[
				"dotnet:build",
				"dotnet:test",
				"bun:run",
				"bun:test",
				"uv:sync",
				"uv:run",
				"go:build",
				"go:test",
			],
		],
		[
			"go",
			"build",
			"[go] BUILD FAILED.",
			[
				"dotnet:build",
				"dotnet:test",
				"bun:run",
				"bun:test",
				"uv:sync",
				"uv:run",
				"go:build",
			],
		],
		[
			"go",
			"test",
			"[go] TESTS FAILED.",
			[
				"dotnet:build",
				"dotnet:test",
				"bun:run",
				"bun:test",
				"uv:sync",
				"uv:run",
				"go:build",
				"go:test",
			],
		],
	] as [string, string, string, string[]][])(
		"returns one for %s %s failure while continuing other detected ecosystems",
		(tool, arg, failure, expected) => {
			const root = project(mixedProject);
			const result = runVerify(root, { FAIL_TOOL: tool, FAIL_ARG: arg });
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain(failure);
			expect(result.stdout).toContain(
				"[dbt] Detected but skipping (needs warehouse credentials).",
			);
			expect(calls().map((call) => `${call.tool}:${call.args[0]}`)).toEqual(
				expected,
			);
		},
	);
});
