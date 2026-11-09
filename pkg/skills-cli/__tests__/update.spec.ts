import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexState, runUpdate, type UpdateDeps } from "../src/update/run";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-update-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function claudePlugin(version: string) {
	mkdirSync(join(home, ".claude", "plugins", "cache", "detailedghost", "dg", version, "plugins", "dg", "skills"), {
		recursive: true,
	});
}

function codexConfig(source: string | undefined, enabled = true) {
	mkdirSync(join(home, ".codex"), { recursive: true });
	const market = source === undefined ? "" : `[marketplaces.detailedghost]\nsource = "${source}"\n\n`;
	writeFileSync(join(home, ".codex", "config.toml"), `${market}[plugins."dg@detailedghost"]\nenabled = ${enabled}\n`);
}

function codexPlugin(version: string) {
	mkdirSync(join(home, ".codex", "plugins", "cache", "detailedghost", "dg", version), { recursive: true });
}

type Fake = UpdateDeps & { calls: string[]; lines: string[]; installs: (string | undefined)[] };

function fake(overrides: Partial<UpdateDeps> & { failing?: string[]; tools?: string[] } = {}): Fake {
	const calls: string[] = [];
	const lines: string[] = [];
	const installs: (string | undefined)[] = [];
	const tools = overrides.tools ?? ["claude", "codex"];
	const failing = overrides.failing ?? [];
	return {
		home,
		calls,
		lines,
		installs,
		install: async (version) => {
			installs.push(version);
		},
		newestVersion: async (version) => version ?? "3.1.0",
		installedVersion: () => "3.1.0",
		which: (name) => (tools.includes(name) ? `/usr/bin/${name}` : null),
		run: (argv) => {
			const line = argv.join(" ");
			calls.push(line);
			return failing.includes(line)
				? { status: 1, stdout: "", stderr: `${argv[0]} broke\n` }
				: { status: 0, stdout: "", stderr: "" };
		},
		doctorSummary: async () => "10 passed, 0 info, 0 to review, 0 failed",
		log: (line) => lines.push(line),
		...overrides,
	};
}

describe("dg-skills update", () => {
	test("installs, updates both plugins, runs doctor, and exits 0", async () => {
		claudePlugin("3.0.1");
		codexConfig("https://github.com/detailedghost/dg-ai.git");
		const d = fake();
		expect(await runUpdate({}, d)).toBe(0);
		expect(d.installs).toEqual([undefined]);
		expect(d.calls).toEqual([
			"claude plugin marketplace update detailedghost",
			"claude plugin update dg@detailedghost",
			"codex plugin marketplace upgrade detailedghost",
			"codex plugin add dg@detailedghost",
		]);
		expect(d.lines.join("\n")).toContain("Doctor: 10 passed");
		expect(d.lines.at(-1)).toContain("Restart Claude Code and Codex sessions");
	});

	test("--version pins the install", async () => {
		const d = fake({ tools: [] });
		await runUpdate({ version: "3.0.0" }, d);
		expect(d.installs).toEqual(["3.0.0"]);
	});

	test("installs the Claude plugin when none is installed, adding the marketplace when update fails", async () => {
		const d = fake({ tools: ["claude"], failing: ["claude plugin marketplace update detailedghost"] });
		expect(await runUpdate({}, d)).toBe(0);
		expect(d.calls).toEqual([
			"claude plugin marketplace update detailedghost",
			"claude plugin marketplace add detailedghost/dg-ai",
			"claude plugin install dg@detailedghost",
		]);
	});

	test("repoints a Codex marketplace that names a local folder", async () => {
		codexConfig("/home/someone/code/dg");
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
		codexConfig("detailedghost/dg-ai", false);
		const d = fake({ tools: ["codex"] });
		expect(await runUpdate({}, d)).toBe(0);
		expect(d.calls).toEqual([]);
		const text = d.lines.join("\n");
		expect(text).toContain("⏭️ Claude plugin: claude is not on PATH");
		expect(text).toContain("⏭️ Codex plugin: dg@detailedghost is not enabled");
	});

	test("a failed step is reported, the rest still run, and the exit is 1", async () => {
		claudePlugin("3.0.1");
		codexConfig("detailedghost/dg-ai");
		const d = fake({
			install: async () => {
				throw new Error("network down");
			},
			failing: ["claude plugin update dg@detailedghost"],
		});
		expect(await runUpdate({}, d)).toBe(1);
		const text = d.lines.join("\n");
		expect(text).toContain("❌ CLI, runtime and extension: network down");
		expect(text).toContain("❌ Claude plugin: claude plugin update dg@detailedghost: claude broke");
		expect(d.calls).toContain("codex plugin add dg@detailedghost");
		expect(text).toContain("Doctor:");
	});

	test("--check lists what is behind, changes nothing, and exits 1", async () => {
		claudePlugin("1.34.2");
		codexConfig("detailedghost/dg-ai");
		codexPlugin("1.0.1");
		const d = fake();
		expect(await runUpdate({ check: true }, d)).toBe(1);
		expect(d.calls).toEqual([]);
		expect(d.installs).toEqual([]);
		expect(d.lines).toEqual([
			"✅ dg CLI: 3.1.0",
			"⬆️ Claude plugin: 1.34.2 -> 3.1.0",
			"⬆️ Codex plugin: 1.0.1 -> 3.1.0",
			"Run dg-skills update to bring these up to date.",
		]);
	});

	test("--check exits 0 when everything is current", async () => {
		claudePlugin("3.1.0");
		const d = fake({ tools: ["claude"] });
		expect(await runUpdate({ check: true }, d)).toBe(0);
		expect(d.lines.at(-1)).toBe("Everything is at 3.1.0.");
	});
});

describe("codexState", () => {
	test("is disabled when there is no Codex config", () => {
		expect(codexState(home)).toEqual({ enabled: false });
	});

	test("reads the plugin flag and the marketplace source", () => {
		codexConfig("detailedghost/dg-ai");
		expect(codexState(home)).toEqual({ enabled: true, source: "detailedghost/dg-ai" });
	});
});
