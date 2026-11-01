import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../../src/hooks/cli";
import { HOOKS } from "../../src/hooks/manifest";
import { isOwned } from "../../src/hooks/settings/marker";
import { ownedObjects, settingsWorld } from "./settings-fixtures";

let world: ReturnType<typeof settingsWorld>;
beforeEach(() => {
	world = settingsWorld();
});
afterEach(() => world.cleanup());

const localeSpec = HOOKS.find((h) => h.id === "spelling")?.settings?.locale;
if (!localeSpec) throw new Error("spelling locale setting missing");

describe("hooks list", () => {
	test("prints id, summary and runtimes for every manifest hook", async () => {
		const result = await world.cli(["list"]);
		expect(result.code).toBe(0);
		for (const hook of HOOKS) {
			expect(result.stdout).toContain(hook.id);
			expect(result.stdout).toContain(hook.summary);
			for (const runtime of hook.runtimes)
				expect(result.stdout).toContain(runtime);
		}
	});
});

describe("hooks set", () => {
	test("rejects an unsupported value, lists the allowed ones and writes nothing", async () => {
		const result = await world.cli(["set", "spelling", "locale", "fr"]);
		expect(result.code).toBe(2);
		for (const value of localeSpec.values)
			expect(result.stderr).toContain(value);
		expect(world.has(world.paths.config)).toBe(false);
	});

	test("stores an allowed value in config.json", async () => {
		const result = await world.cli(["set", "spelling", "locale", "en-GB"]);
		expect(result.code).toBe(0);
		expect(
			world.readJson<{ hooks: unknown }>(world.paths.config).hooks,
		).toEqual({
			spelling: { locale: "en-GB" },
		});
	});

	test("enable --set stores the value alongside the enable", async () => {
		world.seed(world.paths.claude, {});
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
			"--set",
			"locale=en-GB",
		]);
		expect(result.code).toBe(0);
		expect(
			world.readJson<{ hooks: unknown }>(world.paths.config).hooks,
		).toEqual({
			spelling: { locale: "en-GB" },
		});
	});
});

describe("hooks enable defaults", () => {
	test("targets only runtimes whose settings dir exists", async () => {
		world.seed(world.paths.claude, {});
		const result = await world.cli(["enable", "format"]);
		expect(result.code).toBe(0);
		expect(world.has(world.paths.codex)).toBe(false);
		expect(world.has(world.paths.opencodePlugin)).toBe(false);
		expect(result.stdout).toContain("claude: enabled format");
	});

	test("fresh settings.json: enable spelling pr-confirm lists both under claude in status", async () => {
		world.seed(world.paths.claude, {});
		const enable = await world.cli(["enable", "spelling", "pr-confirm"]);
		expect(enable.code).toBe(0);
		const status = await world.cli(["status", "--json"]);
		const parsed = JSON.parse(status.stdout);
		const claude = parsed.runtimes.claude;
		expect([...claude.enabled].sort()).toEqual(["pr-confirm", "spelling"]);
		expect(claude.settingsFile).toBe(world.paths.claude);
	});

	test("codex and opencode present: enable format reaches both", async () => {
		world.seed(world.paths.codex, {});
		world.seed(world.paths.opencodeJson, {});
		const result = await world.cli(["enable", "format"]);
		expect(result.code).toBe(0);
		expect(ownedObjects(world.readJson(world.paths.codex))).toHaveLength(1);
		expect(world.text(world.paths.opencodePlugin)).toContain(
			"hooks run format",
		);
	});
});

describe("hooks disable --all", () => {
	test("leaves no owned command in any runtime file and keeps config.json", async () => {
		world.seed(world.paths.claude, {});
		world.seed(world.paths.codex, {});
		world.seed(world.paths.opencodeJson, { plugin: ["other-plugin"] });
		await world.cli(["set", "spelling", "locale", "en-GB"]);
		const enabled = await world.cli([
			"enable",
			"spelling",
			"format",
			"pr-prose",
			"daily-prune",
		]);
		expect(enabled.code).toBe(0);
		expect(ownedObjects(world.readJson(world.paths.claude))).toHaveLength(4);
		expect(
			ownedObjects(world.readJson(world.paths.codex)).length,
		).toBeGreaterThan(0);
		expect(world.has(world.paths.opencodePlugin)).toBe(true);
		const configBefore = world.text(world.paths.config);

		const result = await world.cli(["disable", "--all"]);
		expect(result.code).toBe(0);

		for (const file of [world.paths.claude, world.paths.codex]) {
			expect(ownedObjects(world.readJson(file))).toEqual([]);
			expect(world.text(file)).not.toMatch(/dg-skills(\.cmd|\.exe)? hooks run/);
		}
		expect(world.has(world.paths.opencodePlugin)).toBe(false);
		expect(
			world.readJson<{ plugin: string[] }>(world.paths.opencodeJson).plugin,
		).toEqual(["other-plugin"]);
		expect(world.text(world.paths.config)).toBe(configBefore);
	});
});

describe("hooks status", () => {
	test("plain text lists enabled ids per runtime with the file path and config values", async () => {
		world.seed(world.paths.claude, {});
		world.seed(world.paths.codex, {});
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		const result = await world.cli(["status"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`claude: spelling (${world.paths.claude})`);
		expect(result.stdout).toContain(`codex: none (${world.paths.codex})`);
		expect(result.stdout).toContain(`spelling.locale = ${localeSpec.default}`);
	});

	test("shows a stored config value over the default", async () => {
		await world.cli(["set", "spelling", "locale", "en-GB"]);
		const result = await world.cli(["status"]);
		expect(result.stdout).toContain("spelling.locale = en-GB");
	});
});

describe("hooks usage errors", () => {
	test("disable of an unknown id exits 2 and names the id", async () => {
		world.seed(world.paths.claude, {});
		const result = await world.cli(["disable", "nope"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("unknown hook nope");
	});

	test("an invalid --runtime value exits 2, lists the allowed ones and writes nothing", async () => {
		world.seed(world.paths.claude, {});
		const before = world.text(world.paths.claude);
		const result = await world.cli(["enable", "format", "--runtime", "bogus"]);
		expect(result.code).toBe(2);
		for (const runtime of ["claude", "codex", "opencode"])
			expect(result.stderr).toContain(runtime);
		expect(world.text(world.paths.claude)).toBe(before);
	});

	test("enable with no runtime found exits 1 and writes nothing", async () => {
		const result = await world.cli(["enable", "format"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no supported runtime found");
		expect(world.has(join(world.home, ".claude"))).toBe(false);
		expect(world.has(world.paths.opencodePlugin)).toBe(false);
	});

	test("a relative launcher is refused with exit 2", async () => {
		world.seed(world.paths.claude, {});
		const before = world.text(world.paths.claude);
		const result = await world.cli(["enable", "format"], {
			launcher: "bin/dg-skills",
		});
		expect(result.code).toBe(2);
		expect(world.text(world.paths.claude)).toBe(before);
	});

	test("a launcher path with a space is refused or written quoted", async () => {
		world.seed(world.paths.claude, {});
		const spaced = join(world.dgHome, "my bin", "dg-skills");
		const result = await world.cli(["enable", "format"], { launcher: spaced });
		if (result.code !== 0) {
			expect(world.readJson(world.paths.claude)).toEqual({});
			return;
		}
		const command = world.readJson(world.paths.claude).hooks?.PostToolUse?.[0]
			?.hooks[0]?.command;
		expect(command).toMatch(new RegExp(`^["']${spaced}["'] hooks run format$`));
		expect(isOwned(command ?? "")).toBe(true);
	});
});

describe("hooks optimistic lock", () => {
	test("exits 1 with the retry message and writes no dg entry when the file keeps changing", async () => {
		const file = world.seed(world.paths.claude, { n: 0 });
		const format = HOOKS.find((h) => h.id === "format");
		if (!format) throw new Error("format manifest entry missing");
		const original = format.event;
		let writes = 0;
		Object.defineProperty(format, "event", {
			configurable: true,
			get() {
				writeFileSync(file, JSON.stringify({ n: ++writes }));
				return original;
			},
		});
		let result: Awaited<ReturnType<typeof world.cli>>;
		try {
			result = await world.cli(["enable", "format", "--runtime", "claude"]);
		} finally {
			Object.defineProperty(format, "event", {
				configurable: true,
				writable: true,
				value: original,
			});
		}
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`${file} kept changing; try again`);
		expect(result.stdout).not.toContain("enabled");
		expect(world.readJson(file).hooks).toBeUndefined();
	});
});

describe("hooks cli edge cases", () => {
	test("set rejects inherited property names as unknown settings", async () => {
		for (const key of ["constructor", "toString"]) {
			const result = await world.cli(["set", "spelling", key, "x"]);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("no setting");
		}
		const viaEnable = await world.cli([
			"enable",
			"spelling",
			"--set",
			"toString=x",
		]);
		expect(viaEnable.code).toBe(2);
	});

	test("an unknown command prints usage with exit 2 even with unknown flags", async () => {
		const result = await world.cli(["bogus", "--x"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("usage:");
	});

	test("a relative launcher is refused with exit 2 and nothing is written", async () => {
		world.seed(world.paths.claude, {});
		const result = await main(["enable", "spelling"], {
			stdin: Readable.from([]),
			env: { DG_HOME: world.dgHome },
			home: world.home,
			launcher: ".dg/bin/dg-skills",
			seams: {
				run: async () => ({ status: 0, stdout: "", stderr: "" }),
				which: () => undefined,
				spawnDetached: () => {},
				stdout: () => {},
				stderr: () => {},
			},
		});
		expect(result).toBe(2);
		expect(world.text(world.paths.claude)).toBe("{}");
	});

	test("status reports a broken runtime file and still lists the others", async () => {
		world.seed(world.paths.claude, {});
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		world.seed(world.paths.codex, "{ broken");
		const result = await world.cli(["status"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("claude: spelling");
		expect(result.stdout).toContain("codex: error:");
		const json = JSON.parse((await world.cli(["status", "--json"])).stdout);
		expect(json.runtimes.claude.enabled).toEqual(["spelling"]);
		expect(json.runtimes.codex.error).toContain(world.paths.codex);
	});

	test("an invalid file in one runtime stops the enable before any runtime is written", async () => {
		world.seed(world.paths.claude, {});
		world.seed(world.paths.codex, "{ broken");
		const result = await world.cli([
			"enable",
			"spelling",
			"--set",
			"locale=en-GB",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(world.paths.codex);
		expect(world.text(world.paths.claude)).toBe("{}");
		expect(world.has(world.paths.config)).toBe(false);
	});

	test("a malformed config.json stops enable --set before any runtime is written", async () => {
		world.seed(world.paths.claude, {});
		world.seed(world.paths.config, "{ broken");
		const result = await world.cli([
			"enable",
			"spelling",
			"--set",
			"locale=en-GB",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(world.paths.config);
		expect(world.text(world.paths.claude)).toBe("{}");
	});

	test("a failure in a later runtime reports what changed and skips --set", async () => {
		world.seed(world.paths.claude, {});
		world.seed(world.paths.codex, {});
		chmodSync(world.paths.codex, 0o444);
		const result = await world.cli([
			"enable",
			"spelling",
			"--set",
			"locale=en-GB",
		]);
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("claude: enabled spelling");
		expect(result.stderr).toContain("codex");
		expect(result.stderr).toContain("changed before the failure: claude");
		expect(world.has(world.paths.config)).toBe(false);
		expect(ownedObjects(world.readJson(world.paths.claude))).toHaveLength(1);
	});

	test("a relative DG_HOME is refused with exit 2 and nothing is written", async () => {
		world.seed(world.paths.claude, {});
		const result = await main(["enable", "spelling"], {
			stdin: Readable.from([]),
			env: { DG_HOME: "relative/dg" },
			home: world.home,
			seams: {
				run: async () => ({ status: 0, stdout: "", stderr: "" }),
				which: () => undefined,
				spawnDetached: () => {},
				stdout: () => {},
				stderr: () => {},
			},
		});
		expect(result).toBe(2);
		expect(world.text(world.paths.claude)).toBe("{}");
	});
});
