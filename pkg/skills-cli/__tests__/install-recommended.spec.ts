import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { installRecommendedForClaude, recommendedPlugins } from "../src/install/recommended-plugins";
import {
	removeRecommendedFixtures,
	tempDir,
	writeInstalledPlugins,
} from "./recommended-fixtures";
import { unslopCheck } from "../src/doctor/checks";
import { fetchedUrls, installEnv, runCli, writeReleaseServer } from "./runtime-bundle-fixtures";

const REPO = join(import.meta.dir, "..", "..", "..");
const ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const MARKETPLACE = JSON.parse(
	readFileSync(join(REPO, ".claude-plugin", "marketplace.json"), "utf8"),
) as { plugins: { name: string; source: string | { sha: string; repo: string } }[] };

type Result = { status: number | null; stdout: string; stderr: string };

function recordingRunner(results: Record<string, Result> = {}, after?: { home: string; shas: Record<string, string> }) {
	const calls: string[][] = [];
	const marketplaceCalls: string[][] = [];
	const run = (argv: string[]): Result => {
		if (argv[2] === "marketplace") {
			marketplaceCalls.push(argv);
			return { status: 0, stdout: "", stderr: "" };
		}
		calls.push(argv);
		const result = results[argv.slice(1).join(" ")] ?? { status: 0, stdout: "{}", stderr: "" };
		if (after && argv[2] === "install" && result.status === 0) writeInstalledPlugins(after.home, after.shas);
		return result;
	};
	return { calls, marketplaceCalls, run };
}

function writeInstalledPluginsRaw(home: string, plugins: Record<string, { scope?: string; gitCommitSha: string }[]>) {
	const file = join(home, ".claude", "plugins", "installed_plugins.json");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ version: 2, plugins }));
}

function plugin(name: string, sha: string) {
	return { name, repo: `owner/${name}`, sha };
}

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
	delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
	removeRecommendedFixtures();
	if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

describe("recommendedPlugins", () => {
	test("lists every marketplace entry except dg, with the pinned sha", () => {
		const expected = MARKETPLACE.plugins
			.filter((entry) => entry.name !== "dg")
			.map((entry) => ({ name: entry.name, sha: (entry.source as { sha: string }).sha }))
			.sort((a, b) => a.name.localeCompare(b.name));
		const actual = recommendedPlugins()
			.map(({ name, sha }) => ({ name, sha }))
			.sort((a, b) => a.name.localeCompare(b.name));
		expect(actual).toEqual(expected);
		expect(actual.map((entry) => entry.name)).not.toContain("dg");
		expect(actual.length).toBeGreaterThan(0);
	});

	test("carries the skills key and repo of each entry", () => {
		const unslop = recommendedPlugins().find((entry) => entry.name === "unslop");
		const source = MARKETPLACE.plugins.find((entry) => entry.name === "unslop")?.source as { repo: string };
		expect(unslop?.skills).toEqual(["./"]);
		expect(unslop?.repo).toBe(source.repo);
		expect(recommendedPlugins().find((entry) => entry.name === "mattpocock-skills")?.skills).toBeUndefined();
	});
});

describe("installRecommendedForClaude", () => {
	const SHA_A = "a".repeat(40);
	const SHA_B = "b".repeat(40);

	test("installs a plugin that installed_plugins.json does not list", () => {
		const home = tempDir("recommended-home");
		const { calls, run } = recordingRunner({}, { home, shas: { "unslop@detailedghost": SHA_A } });
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, (line) => lines.push(line));
		expect(calls).toEqual([["claude", "plugin", "install", "unslop@detailedghost", "--json"]]);
		expect(lines).toEqual([`unslop installed at ${SHA_A.slice(0, 7)}.`]);
	});

	test("installs when installed_plugins.json is missing or the file has no entry for the plugin", () => {
		const home = tempDir("recommended-home");
		writeInstalledPlugins(home, { "other@detailedghost": SHA_A });
		const { calls, run } = recordingRunner();
		installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, () => {});
		expect(calls.map((argv) => argv[2])).toEqual(["install"]);
	});

	test("uninstalls then installs when the installed sha differs from the pin", () => {
		const home = tempDir("recommended-home");
		writeInstalledPlugins(home, { "unslop@detailedghost": SHA_A });
		const { calls, run } = recordingRunner({}, { home, shas: { "unslop@detailedghost": SHA_B } });
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_B)], home, run, (line) => lines.push(line));
		expect(calls).toEqual([
			["claude", "plugin", "uninstall", "unslop@detailedghost"],
			["claude", "plugin", "install", "unslop@detailedghost", "--json"],
		]);
		expect(lines).toEqual([`unslop updated to ${SHA_B.slice(0, 7)}.`]);
	});

	test("runs nothing when the installed sha equals the pin", () => {
		const home = tempDir("recommended-home");
		writeInstalledPlugins(home, { "unslop@detailedghost": SHA_A });
		const { calls, run } = recordingRunner();
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, (line) => lines.push(line));
		expect(calls).toEqual([]);
		expect(lines).toHaveLength(1);
	});

	test("handles each plugin on its own", () => {
		const home = tempDir("recommended-home");
		writeInstalledPlugins(home, { "one@detailedghost": SHA_A, "two@detailedghost": SHA_A });
		const { calls, run } = recordingRunner(
			{},
			{ home, shas: { "one@detailedghost": SHA_A, "two@detailedghost": SHA_B, "three@detailedghost": SHA_B } },
		);
		installRecommendedForClaude(
			[plugin("one", SHA_A), plugin("two", SHA_B), plugin("three", SHA_B)],
			home,
			run,
			() => {},
		);
		expect(calls.map((argv) => argv.slice(2).join(" "))).toEqual([
			"uninstall two@detailedghost",
			"install two@detailedghost --json",
			"install three@detailedghost --json",
		]);
	});

	test("prints one line per plugin naming it and the short pinned sha", () => {
		const home = tempDir("recommended-home");
		writeInstalledPlugins(home, { "kept@detailedghost": SHA_A, "moved@detailedghost": SHA_A });
		const run = (argv: string[]): Result => {
			if (argv[2] === "install") {
				writeInstalledPlugins(home, {
					"kept@detailedghost": SHA_A,
					"moved@detailedghost": SHA_B,
					"fresh@detailedghost": SHA_B,
				});
			}
			return { status: 0, stdout: "", stderr: "" };
		};
		const lines: string[] = [];
		installRecommendedForClaude(
			[plugin("kept", SHA_A), plugin("moved", SHA_B), plugin("fresh", SHA_B)],
			home,
			run,
			(line) => lines.push(line),
		);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("kept");
		expect(lines[0]).toContain(SHA_A.slice(0, 7));
		expect(lines[1]).toContain("moved");
		expect(lines[1]).toContain(SHA_B.slice(0, 7));
		expect(lines[2]).toContain("fresh");
		expect(lines[2]).toContain(SHA_B.slice(0, 7));
		expect(new Set(lines).size).toBe(3);
		expect(lines.filter((line) => line.startsWith("⚠"))).toEqual([]);
	});

	test("a runner that throws ENOENT warns once and does not throw", () => {
		const home = tempDir("recommended-home");
		const lines: string[] = [];
		const run = (): Result => {
			throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
		};
		expect(() =>
			installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, (line) => lines.push(line)),
		).not.toThrow();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^⚠ unslop skipped: /);
	});

	test("a failed command warns for that plugin and the next plugin still installs", () => {
		const home = tempDir("recommended-home");
		const { calls, run } = recordingRunner(
			{ "plugin install one@detailedghost --json": { status: 1, stdout: "", stderr: "boom" } },
			{ home, shas: { "two@detailedghost": SHA_A } },
		);
		const lines: string[] = [];
		installRecommendedForClaude([plugin("one", SHA_A), plugin("two", SHA_A)], home, run, (line) =>
			lines.push(line),
		);
		expect(calls.map((argv) => argv[3])).toEqual(["one@detailedghost", "two@detailedghost"]);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/^⚠ one skipped: .*boom/);
		expect(lines[1]).not.toMatch(/^⚠/);
	});

	test("a failed reinstall after a successful uninstall says the old copy is gone and runs nothing more", () => {
		const home = tempDir("recommended-home");
		writeInstalledPlugins(home, { "unslop@detailedghost": SHA_A });
		const { calls, run } = recordingRunner({
			"plugin install unslop@detailedghost --json": { status: 1, stdout: "", stderr: "first\nsecond" },
		});
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_B)], home, run, (line) => lines.push(line));
		expect(calls.map((argv) => argv[2])).toEqual(["uninstall", "install"]);
		expect(lines).toEqual(["⚠ unslop removed: reinstall failed: first"]);
	});

	test("refreshes the marketplace once before installing and not when every plugin is current", () => {
		const home = tempDir("recommended-home");
		const stale = recordingRunner({}, { home, shas: { "one@detailedghost": SHA_A, "two@detailedghost": SHA_A } });
		installRecommendedForClaude([plugin("one", SHA_A), plugin("two", SHA_A)], home, stale.run, () => {});
		expect(stale.marketplaceCalls).toEqual([["claude", "plugin", "marketplace", "update", "detailedghost"]]);
		writeInstalledPlugins(home, { "one@detailedghost": SHA_A });
		const current = recordingRunner();
		installRecommendedForClaude([plugin("one", SHA_A)], home, current.run, () => {});
		expect(current.marketplaceCalls).toEqual([]);
	});

	test("uninstalls and says so when the installed sha still differs from the pin after install", () => {
		const home = tempDir("recommended-home");
		const { calls, run } = recordingRunner({}, { home, shas: { "unslop@detailedghost": SHA_A } });
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_B)], home, run, (line) => lines.push(line));
		expect(calls.map((argv) => argv.slice(2).join(" "))).toEqual([
			"install unslop@detailedghost --json",
			"uninstall unslop@detailedghost",
		]);
		expect(lines).toEqual([`⚠ unslop removed: installed ${SHA_A.slice(0, 7)}, expected ${SHA_B.slice(0, 7)}`]);
	});

	test("reports a failed uninstall after a sha mismatch", () => {
		const home = tempDir("recommended-home");
		const { run } = recordingRunner(
			{ "plugin uninstall unslop@detailedghost": { status: 1, stdout: "", stderr: "locked\nmore" } },
			{ home, shas: { "unslop@detailedghost": SHA_A } },
		);
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_B)], home, run, (line) => lines.push(line));
		expect(lines).toEqual([
			`⚠ unslop skipped: installed ${SHA_A.slice(0, 7)}, expected ${SHA_B.slice(0, 7)}; uninstall failed: locked`,
		]);
	});

	test("installs when only a project-scope entry holds the pin", () => {
		const home = tempDir("recommended-home");
		writeInstalledPluginsRaw(home, {
			"unslop@detailedghost": [{ scope: "project", gitCommitSha: SHA_A }],
		});
		const { calls, run } = recordingRunner({}, { home, shas: { "unslop@detailedghost": SHA_A } });
		installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, () => {});
		expect(calls.map((argv) => argv[2])).toEqual(["install"]);
	});

	test("runs nothing when the user entry holds the pin and a project entry holds another sha", () => {
		const home = tempDir("recommended-home");
		writeInstalledPluginsRaw(home, {
			"unslop@detailedghost": [
				{ scope: "project", gitCommitSha: SHA_B },
				{ scope: "user", gitCommitSha: SHA_A },
			],
		});
		const { calls, run } = recordingRunner();
		installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, () => {});
		expect(calls).toEqual([]);
	});

	test("reports an unverifiable install without claiming the pin or uninstalling", () => {
		const home = tempDir("recommended-home");
		const { calls, run } = recordingRunner();
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, (line) => lines.push(line));
		expect(calls.map((argv) => argv[2])).toEqual(["install"]);
		expect(lines).toEqual(["⚠ unslop installed, but its commit could not be verified"]);
	});

	test("reports an unverifiable install when installed_plugins.json is malformed or lacks a sha", () => {
		for (const content of ["not json", JSON.stringify({ plugins: { "unslop@detailedghost": [{ scope: "user" }] } })]) {
			const home = tempDir("recommended-home");
			const file = join(home, ".claude", "plugins", "installed_plugins.json");
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, content);
			const { calls, run } = recordingRunner();
			const lines: string[] = [];
			installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, (line) => lines.push(line));
			expect(calls.map((argv) => argv[2])).toEqual(["install"]);
			expect(lines).toEqual(["⚠ unslop installed, but its commit could not be verified"]);
		}
	});

	test("reads installed_plugins.json from CLAUDE_CONFIG_DIR when set", () => {
		const home = tempDir("recommended-home");
		const config = tempDir("recommended-config");
		const file = join(config, "plugins", "installed_plugins.json");
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({ plugins: { "unslop@detailedghost": [{ gitCommitSha: SHA_A }] } }),
		);
		process.env.CLAUDE_CONFIG_DIR = config;
		const { calls, run } = recordingRunner();
		installRecommendedForClaude([plugin("unslop", SHA_A)], home, run, () => {});
		expect(calls).toEqual([]);
	});

	test("a failed uninstall warns and does not run the install", () => {
		const home = tempDir("recommended-home");
		writeInstalledPlugins(home, { "unslop@detailedghost": SHA_A });
		const { calls, run } = recordingRunner({
			"plugin uninstall unslop@detailedghost": { status: 2, stdout: "", stderr: "" },
		});
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_B)], home, run, (line) => lines.push(line));
		expect(calls.map((argv) => argv[2])).toEqual(["uninstall"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^⚠ unslop skipped: /);
	});

	test("an install that fails after a successful uninstall warns once", () => {
		const home = tempDir("recommended-home");
		writeInstalledPlugins(home, { "unslop@detailedghost": SHA_A });
		const { calls, run } = recordingRunner({
			"plugin install unslop@detailedghost --json": { status: 1, stdout: "", stderr: "network down" },
		});
		const lines: string[] = [];
		installRecommendedForClaude([plugin("unslop", SHA_B)], home, run, (line) => lines.push(line));
		expect(calls.map((argv) => argv[2])).toEqual(["uninstall", "install"]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/^⚠ unslop removed: reinstall failed: network down/);
		expect(lines[0].split("\n")).toHaveLength(1);
	});
});

function fakeClaudeBin(root: string): { bin: string; log: string } {
	const bin = join(root, "fakebin");
	const log = join(root, "claude.log");
	mkdirSync(bin, { recursive: true });
	writeFileSync(log, "");
	const script = join(bin, "claude");
	const plugins = JSON.stringify({
		version: 2,
		plugins: Object.fromEntries(
			recommendedPlugins().map((entry) => [`${entry.name}@detailedghost`, [{ scope: "user", gitCommitSha: entry.sha }]]),
		),
	});
	const installed = join(root, "home", ".claude", "plugins", "installed_plugins.json");
	writeFileSync(
		script,
		`#!/bin/sh\necho "$@" >> "${log}"\nif [ "$2" = install ]; then mkdir -p "${dirname(installed)}"; printf '%s' '${plugins}' > "${installed}"; fi\necho '{}'\nexit 0\n`,
		{ mode: 0o755 },
	);
	return { bin, log };
}

function pathWithout(program: string): string {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter((dir) => dir !== "" && !existsSync(join(dir, program)))
		.concat(dirname(process.execPath))
		.join(delimiter);
}

describe("dg-skills install --with-recommended", () => {
	test("rejects --agent-only before fetching anything", async () => {
		const root = tempDir("recommended-agent-only");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(root, "fetch.log");
		writeFileSync(fetchLog, "");
		const { preload } = writeReleaseServer(root, fetchLog, "9.9.9");
		const result = await runCli(
			["bun", "--preload", preload, ENTRY, "install", "--agent-only", "--with-recommended"],
			installEnv(home),
		);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("--with-recommended");
		expect(fetchedUrls(fetchLog)).toEqual([]);
		expect(existsSync(join(home, "bin"))).toBe(false);
	});

	test("is listed in install --help with the plugin names", async () => {
		const home = tempDir("recommended-help");
		const result = await runCli(["bun", ENTRY, "install", "--help"], installEnv(home));
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("--with-recommended");
		for (const entry of recommendedPlugins()) expect(result.stdout).toContain(entry.name);
	});

	test("--cli-only installs every recommended plugin at its pin through the claude CLI", async () => {
		const root = tempDir("recommended-cli-only");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(root, "fetch.log");
		writeFileSync(fetchLog, "");
		const { preload } = writeReleaseServer(root, fetchLog, "9.9.9");
		const fake = fakeClaudeBin(root);
		const env = { ...installEnv(home), PATH: `${fake.bin}${delimiter}${process.env.PATH ?? ""}` };
		const result = await runCli(
			["bun", "--preload", preload, ENTRY, "install", "--cli-only", "--with-recommended"],
			env,
		);
		expect(result.code).toBe(0);
		const calls = readFileSync(fake.log, "utf8").split("\n").filter(Boolean);
		for (const entry of recommendedPlugins()) {
			expect(calls).toContain(`plugin install ${entry.name}@detailedghost --json`);
			expect(result.stdout).toContain(entry.sha.slice(0, 7));
		}
	});

	test("--cli-only without the claude binary warns for the plugins and exits 0", async () => {
		const root = tempDir("recommended-no-claude");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(root, "fetch.log");
		writeFileSync(fetchLog, "");
		const { preload } = writeReleaseServer(root, fetchLog, "9.9.9");
		const env = { ...installEnv(home), PATH: pathWithout("claude") };
		const result = await runCli(
			["bun", "--preload", preload, ENTRY, "install", "--cli-only", "--with-recommended"],
			env,
		);
		expect(result.code).toBe(0);
		const output = `${result.stdout}\n${result.stderr}`;
		for (const entry of recommendedPlugins()) {
			expect(output).toMatch(new RegExp(`⚠ ${entry.name} skipped`));
		}
	});

	test("without the flag the claude binary is never run", async () => {
		const root = tempDir("recommended-off");
		const home = join(root, "home");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(root, "fetch.log");
		writeFileSync(fetchLog, "");
		const { preload } = writeReleaseServer(root, fetchLog, "9.9.9");
		const fake = fakeClaudeBin(root);
		const env = { ...installEnv(home), PATH: `${fake.bin}${delimiter}${process.env.PATH ?? ""}` };
		const result = await runCli(["bun", "--preload", preload, ENTRY, "install", "--cli-only"], env);
		expect(result.code).toBe(0);
		expect(readFileSync(fake.log, "utf8")).toBe("");
	});
});

describe("dg-skills install --skills-only --with-recommended offline", () => {
	test("installs dg skills and prints one warning per recommended plugin when git cannot reach them", async () => {
		const root = tempDir("recommended-offline");
		const home = join(root, "home");
		const dest = join(root, "dest");
		mkdirSync(home, { recursive: true });
		const fetchLog = join(root, "fetch.log");
		writeFileSync(fetchLog, "");
		const { preload } = writeReleaseServer(root, fetchLog, "9.9.9");
		const plugins = recommendedPlugins();
		const env: Record<string, string> = {
			...installEnv(home),
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_COUNT: String(plugins.length),
		};
		plugins.forEach((entry, index) => {
			env[`GIT_CONFIG_KEY_${index}`] = `url.file://${join(root, "missing", entry.name)}.insteadOf`;
			env[`GIT_CONFIG_VALUE_${index}`] = `https://github.com/${entry.repo}.git`;
		});
		const result = await runCli(
			["bun", "--preload", preload, ENTRY, "install", "--skills-only", "--dest", dest, "--with-recommended"],
			env,
		);
		expect(result.code).toBe(0);
		expect(existsSync(join(dest, "address", "SKILL.md"))).toBe(true);
		const output = `${result.stdout}\n${result.stderr}`;
		for (const entry of plugins) {
			expect(output.match(new RegExp(`⚠ ${entry.name} skipped`, "g"))).toHaveLength(1);
			expect(existsSync(join(dest, entry.name))).toBe(false);
		}
	});
});

describe("docs/install.md", () => {
	const doc = readFileSync(join(REPO, "docs", "install.md"), "utf8");

	test("documents --with-recommended, its modes, the agent-only rejection and the /teach and /wait-what source", () => {
		expect(doc).toContain("--with-recommended");
		for (const flag of ["--cli-only", "--skills-only", "--agent-only"]) expect(doc).toContain(flag);
		expect(doc).toContain("/teach");
		expect(doc).toContain("/wait-what");
	});
});

describe("unslopCheck", () => {
	test("tells the user to run install --with-recommended when unslop is missing", () => {
		const home = tempDir("recommended-doctor");
		const result = unslopCheck.run({ home } as never) as { fix?: string; hint?: string };
		expect(JSON.stringify(result)).toContain("dg-skills install --with-recommended");
	});
});
