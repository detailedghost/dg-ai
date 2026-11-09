import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexState, type InstallTarget, runUpdate, type UpdateDeps } from "../src/update/run";

let home: string;
let codexHome: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-update-"));
	codexHome = join(home, "codex-home");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const claudeHome = () => join(home, ".claude");

function claudePlugin(version: string) {
	mkdirSync(join(claudeHome(), "plugins", "cache", "detailedghost", "dg", version), { recursive: true });
	writeFileSync(
		join(claudeHome(), "plugins", "installed_plugins.json"),
		JSON.stringify({ version: 2, plugins: { "dg@detailedghost": [{ scope: "user", version }] } }),
	);
}

function codexConfig(source: string | undefined, { enabled = true, type = "git" } = {}) {
	mkdirSync(codexHome, { recursive: true });
	const market =
		source === undefined ? "" : `[marketplaces.detailedghost]\nsource_type = "${type}"\nsource = "${source}"\n\n`;
	writeFileSync(join(codexHome, "config.toml"), `${market}[plugins."dg@detailedghost"]\nenabled = ${enabled}\n`);
}

function codexPlugin(version: string) {
	mkdirSync(join(codexHome, "plugins", "cache", "detailedghost", "dg", version), { recursive: true });
}

type Fake = UpdateDeps & { calls: string[]; lines: string[]; installs: string[] };

type FakeOptions = Partial<UpdateDeps> & { failing?: string[]; tools?: string[]; stuck?: boolean };

function fake(overrides: FakeOptions = {}): Fake {
	const calls: string[] = [];
	const lines: string[] = [];
	const installs: string[] = [];
	const { failing = [], tools = ["claude", "codex"], stuck = false, ...rest } = overrides;
	let installed = "3.0.1";
	return {
		claudeHome: claudeHome(),
		codexHome,
		calls,
		lines,
		installs,
		install: async (target: InstallTarget, version: string) => {
			installs.push(`${target}@${version}`);
			installed = version;
		},
		newestVersion: async () => "3.1.0",
		installedVersion: () => installed,
		stagedExtensions: () => ({ chrome: "3.0.1" }),
		cliOnly: () => false,
		which: (name) => (tools.includes(name) ? `/usr/bin/${name}` : null),
		run: (argv) => {
			const line = argv.join(" ");
			calls.push(line);
			if (failing.includes(line)) return { status: 1, stdout: "", stderr: `${argv[0]} broke\n` };
			if (!stuck && /^claude plugin (update|install) /.test(line)) claudePlugin("3.1.0");
			if (!stuck && line === "codex plugin add dg@detailedghost") codexPlugin("3.1.0");
			return { status: 0, stdout: "", stderr: "" };
		},
		doctorSummary: async () => "10 passed, 0 info, 0 to review, 0 failed",
		log: (line) => lines.push(line),
		...rest,
	};
}

describe("dg-skills update", () => {
	test("installs the newest release pinned, updates both plugins, runs doctor, and exits 0", async () => {
		claudePlugin("3.0.1");
		codexConfig("https://github.com/detailedghost/dg-ai.git");
		const d = fake();
		expect(await runUpdate({}, d)).toBe(0);
		expect(d.installs).toEqual(["chrome@3.1.0"]);
		expect(d.calls).toEqual([
			"claude plugin marketplace update detailedghost",
			"claude plugin update dg@detailedghost --scope user",
			"codex plugin marketplace upgrade detailedghost",
			"codex plugin add dg@detailedghost",
		]);
		expect(d.lines[0]).toBe("✅ CLI, runtime and extension: dg 3.1.0 installed");
		expect(d.lines.join("\n")).toContain("Doctor (information only, not part of the exit code): 10 passed");
		expect(d.lines.at(-1)).toContain("Restart Claude Code and Codex sessions");
	});

	test("a CLI-only install stays CLI-only", async () => {
		const d = fake({ tools: [], cliOnly: () => true });
		await runUpdate({}, d);
		expect(d.installs).toEqual(["cli-only@3.1.0"]);
	});

	test("refreshes every staged browser target", async () => {
		const d = fake({ tools: [], stagedExtensions: () => ({ chrome: "3.0.1", firefox: "3.0.1" }) });
		await runUpdate({}, d);
		expect(d.installs).toEqual(["chrome@3.1.0", "firefox@3.1.0"]);
	});

	test("fails the install step when the installed version did not move", async () => {
		const d = fake({ tools: [], install: async () => {} });
		expect(await runUpdate({}, d)).toBe(1);
		expect(d.lines[0]).toBe("❌ CLI, runtime and extension: dg 3.0.1 is installed, not 3.1.0");
	});

	test("installs the Claude plugin when none is installed, adding the marketplace when update fails", async () => {
		const d = fake({ tools: ["claude"], failing: ["claude plugin marketplace update detailedghost"] });
		expect(await runUpdate({}, d)).toBe(0);
		expect(d.calls).toEqual([
			"claude plugin marketplace update detailedghost",
			"claude plugin marketplace add detailedghost/dg-ai",
			"claude plugin install dg@detailedghost --scope user",
		]);
	});

	test.each([
		["a local folder", "/home/someone/code/dg"],
		["a local folder whose name ends like the repo", "/home/someone/detailedghost/dg-ai"],
	])("repoints a Codex marketplace that names %s", async (_label, source) => {
		codexConfig(source, { type: "local" });
		const d = fake({ tools: ["codex"] });
		expect(await runUpdate({}, d)).toBe(0);
		expect(d.calls).toEqual([
			"codex plugin marketplace remove detailedghost",
			"codex plugin marketplace add detailedghost/dg-ai",
			"codex plugin add dg@detailedghost",
		]);
		expect(d.lines.join("\n")).toContain("marketplace now detailedghost/dg-ai");
	});

	test("skips Codex when the dg plugin is not enabled there, and tools that are missing", async () => {
		codexConfig("detailedghost/dg-ai", { enabled: false });
		const d = fake({ tools: ["codex"] });
		expect(await runUpdate({}, d)).toBe(0);
		expect(d.calls).toEqual([]);
		const text = d.lines.join("\n");
		expect(text).toContain("⏭️ Claude plugin: claude is not on PATH");
		expect(text).toContain("⏭️ Codex plugin: dg@detailedghost is not enabled");
	});

	test("a failed or throwing step is reported, the rest still run, and the exit is 1", async () => {
		claudePlugin("3.0.1");
		codexConfig("detailedghost/dg-ai");
		const d = fake({
			install: async () => {
				throw new Error("network down");
			},
		});
		const run = d.run;
		d.run = (argv) => {
			if (argv[0] === "claude") throw new Error("claude wrapper cannot start");
			return run(argv);
		};
		expect(await runUpdate({}, d)).toBe(1);
		const text = d.lines.join("\n");
		expect(text).toContain("❌ CLI, runtime and extension: network down");
		expect(text).toContain("❌ Claude plugin: claude wrapper cannot start");
		expect(d.calls).toContain("codex plugin add dg@detailedghost");
		expect(text).toContain("Doctor (information only");
	});

	test("a plugin that stays behind after a clean update fails and points to the pinned-marketplace docs", async () => {
		claudePlugin("3.0.1");
		const d = fake({ tools: ["claude"], stuck: true });
		expect(await runUpdate({}, d)).toBe(1);
		const text = d.lines.join("\n");
		expect(text).toContain("❌ Claude plugin: the dg plugin is 3.0.1, not 3.1.0");
		expect(text).toContain("docs/install.md");
	});

	test("the newest release cannot be read: nothing runs, exit 1", async () => {
		const d = fake({
			newestVersion: async () => {
				throw new Error("GitHub API 503");
			},
		});
		expect(await runUpdate({}, d)).toBe(1);
		expect(d.installs).toEqual([]);
		expect(d.calls).toEqual([]);
		expect(d.lines).toEqual(["❌ Could not read the newest release: GitHub API 503"]);
	});

	test("a nonzero plugin command names the command and its first error line", async () => {
		claudePlugin("3.0.1");
		const d = fake({ tools: ["claude"], failing: ["claude plugin update dg@detailedghost --scope user"] });
		expect(await runUpdate({}, d)).toBe(1);
		expect(d.lines.join("\n")).toContain("❌ Claude plugin: claude plugin update dg@detailedghost --scope user: claude broke");
	});

	test("--check lists what is behind, the staged extension too, changes nothing, and exits 1", async () => {
		claudePlugin("1.34.2");
		codexConfig("detailedghost/dg-ai");
		codexPlugin("1.0.1");
		const d = fake({ installedVersion: () => "3.1.0" });
		expect(await runUpdate({ check: true }, d)).toBe(1);
		expect(d.calls).toEqual([]);
		expect(d.installs).toEqual([]);
		expect(d.lines).toEqual([
			"✅ dg CLI: 3.1.0",
			"⬆️ chrome extension: 3.0.1 -> 3.1.0",
			"⬆️ Claude plugin (user): 1.34.2 -> 3.1.0",
			"⬆️ Codex plugin: 1.0.1 -> 3.1.0",
			"Run dg-skills update to bring these up to date.",
		]);
	});

	test("--check reads the installed Claude plugin, not a newer folder left in the cache", async () => {
		claudePlugin("3.1.0");
		claudePlugin("3.0.1");
		const d = fake({ tools: ["claude"], installedVersion: () => "3.1.0", stagedExtensions: () => ({}) });
		expect(await runUpdate({ check: true }, d)).toBe(1);
		expect(d.lines).toContain("⬆️ Claude plugin (user): 3.0.1 -> 3.1.0");
	});

	test("--check reports the oldest installed scope, so a stale project install is not hidden", async () => {
		mkdirSync(join(claudeHome(), "plugins"), { recursive: true });
		writeFileSync(
			join(claudeHome(), "plugins", "installed_plugins.json"),
			JSON.stringify({
				plugins: { "dg@detailedghost": [{ scope: "user", version: "3.1.0" }, { scope: "project", version: "3.0.1" }] },
			}),
		);
		const d = fake({ tools: ["claude"], installedVersion: () => "3.1.0", stagedExtensions: () => ({}) });
		expect(await runUpdate({ check: true }, d)).toBe(1);
		expect(d.lines).toContain("✅ Claude plugin (user): 3.1.0");
		expect(d.lines).toContain("⬆️ Claude plugin (project): 3.0.1 -> 3.1.0");
	});

	test("update refreshes the user scope and names the command for a stale project scope", async () => {
		mkdirSync(join(claudeHome(), "plugins"), { recursive: true });
		writeFileSync(
			join(claudeHome(), "plugins", "installed_plugins.json"),
			JSON.stringify({
				plugins: {
					"dg@detailedghost": [
						{ scope: "user", version: "3.0.1" },
						{ scope: "project", version: "3.0.1", projectPath: "/work/app" },
					],
				},
			}),
		);
		const d = fake({ tools: ["claude"], stagedExtensions: () => ({}) });
		d.run = (argv) => {
			d.calls.push(argv.join(" "));
			if (argv[2] === "update")
				writeFileSync(
					join(claudeHome(), "plugins", "installed_plugins.json"),
					JSON.stringify({
						plugins: {
							"dg@detailedghost": [
								{ scope: "user", version: "3.1.0" },
								{ scope: "project", version: "3.0.1", projectPath: "/work/app" },
							],
						},
					}),
				);
			return { status: 0, stdout: "", stderr: "" };
		};
		expect(await runUpdate({}, d)).toBe(0);
		expect(d.lines).toContain(
			"⚠️ Claude plugin (project /work/app) is 3.0.1; in /work/app, run claude plugin update dg@detailedghost --scope project",
		);
	});

	test("--check leaves out extension markers on a CLI-only install", async () => {
		const d = fake({ tools: [], cliOnly: () => true, installedVersion: () => "3.1.0" });
		expect(await runUpdate({ check: true }, d)).toBe(0);
		expect(d.lines.join("\n")).not.toContain("extension");
	});

	test("--check exits 0 when everything is current", async () => {
		claudePlugin("3.1.0");
		const d = fake({ tools: ["claude"], installedVersion: () => "3.1.0", stagedExtensions: () => ({ chrome: "3.1.0" }) });
		expect(await runUpdate({ check: true }, d)).toBe(0);
		expect(d.lines.at(-1)).toBe("Everything is at 3.1.0.");
	});
});

describe("codexState", () => {
	test("is disabled when there is no Codex config", () => {
		expect(codexState(codexHome)).toEqual({ enabled: false, local: false });
	});

	test("reads the plugin flag, the marketplace source, and whether it is local", () => {
		codexConfig("/srv/dg", { type: "local" });
		expect(codexState(codexHome)).toEqual({ enabled: true, source: "/srv/dg", local: true });
	});
});
