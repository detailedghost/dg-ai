import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HOOKS } from "../../src/hooks/manifest";
import { ownedCommand } from "../../src/hooks/settings/marker";
import {
	ownedObjects,
	type SettingsFile,
	settingsWorld,
	USER_HOOK,
} from "./settings-fixtures";

let world: ReturnType<typeof settingsWorld>;
beforeEach(() => {
	world = settingsWorld();
});
afterEach(() => world.cleanup());

const spelling = HOOKS.find((h) => h.id === "spelling");
if (!spelling?.matcher) throw new Error("spelling manifest entry changed");
const MATCHER = spelling.matcher;

function userSettings(): SettingsFile {
	return {
		theme: "dark",
		permissions: { allow: ["Bash(ls:*)"] },
		hooks: {
			PostToolUse: [
				{ matcher: "Bash", hooks: [USER_HOOK] },
				{ matcher: MATCHER, hooks: [{ type: "command", command: "fmt-it" }] },
			],
			Stop: [{ hooks: [USER_HOOK] }],
		},
	};
}

describe("claude settings writer", () => {
	test("enable adds one owned object under PostToolUse and keeps every user entry", async () => {
		const before = userSettings();
		world.seed(world.paths.claude, before);
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
		]);
		expect(result.code).toBe(0);
		const after = world.readJson(world.paths.claude);
		expect(ownedObjects(after)).toEqual([
			{ type: "command", command: ownedCommand(world.launcher, "spelling") },
		]);
		const group = after.hooks?.PostToolUse?.find((g) =>
			g.hooks.some(
				(h) => h.command === ownedCommand(world.launcher, "spelling"),
			),
		);
		expect(group?.matcher).toBe(MATCHER);
		const expected = structuredClone(before);
		expected.hooks?.PostToolUse?.[1]?.hooks.push({
			type: "command",
			command: ownedCommand(world.launcher, "spelling"),
		});
		expect(after).toEqual(expected);
	});

	test("enable prints the runtime, id and new-session notice", async () => {
		world.seed(world.paths.claude, {});
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
		]);
		expect(result.stdout).toContain(
			"claude: enabled spelling (takes effect in new sessions)",
		);
	});

	test("enable creates the group in an empty settings.json", async () => {
		world.seed(world.paths.claude, {});
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		expect(world.readJson(world.paths.claude).hooks?.PostToolUse).toEqual([
			{
				matcher: MATCHER,
				hooks: [
					{
						type: "command",
						command: ownedCommand(world.launcher, "spelling"),
					},
				],
			},
		]);
	});

	test("enable creates the file and its directory when settings.json is absent", async () => {
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
		]);
		expect(result.code).toBe(0);
		expect(ownedObjects(world.readJson(world.paths.claude))).toHaveLength(1);
	});

	test("enable of a hook the runtime does not support leaves no file", async () => {
		const result = await world.cli([
			"enable",
			"pr-confirm",
			"--runtime",
			"opencode",
		]);
		expect(result.stdout).toContain("skipped pr-confirm");
		expect(world.has(world.paths.opencodePlugin)).toBe(false);
		const codex = await world.cli([
			"enable",
			"daily-prune",
			"--runtime",
			"opencode",
		]);
		expect(codex.code).toBe(0);
		expect(world.has(world.paths.opencodeJson)).toBe(false);
	});

	test("enable replaces the command of an owned entry that has a stale launcher", async () => {
		const old = ownedCommand("/old/place/dg-skills", "spelling");
		world.seed(world.paths.claude, {
			hooks: {
				PostToolUse: [
					{
						matcher: MATCHER,
						hooks: [USER_HOOK, { type: "command", command: old }],
					},
				],
			},
		});
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		const after = world.readJson(world.paths.claude);
		expect(ownedObjects(after)).toEqual([
			{ type: "command", command: ownedCommand(world.launcher, "spelling") },
		]);
		expect(after.hooks?.PostToolUse?.[0]?.hooks).toHaveLength(2);
		expect(after.hooks?.PostToolUse?.[0]?.hooks[0]).toEqual(USER_HOOK);
	});

	test("a group without a hooks array stays untouched and enable still works", async () => {
		const foreign = { matcher: MATCHER };
		world.seed(world.paths.claude, {
			hooks: { PostToolUse: [foreign, null, { matcher: MATCHER, hooks: [] }] },
		});
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
		]);
		expect(result.code).toBe(0);
		const groups = world.readJson<{ hooks: { PostToolUse: unknown[] } }>(
			world.paths.claude,
		).hooks.PostToolUse;
		expect(groups[0]).toEqual(foreign);
		expect(groups[1]).toBeNull();
		await world.cli(["disable", "--all"]);
		expect(
			world.readJson<{ hooks: { PostToolUse: unknown[] } }>(world.paths.claude)
				.hooks.PostToolUse[0],
		).toEqual(foreign);
	});

	test("an event that is not an array stays untouched when another event is enabled", async () => {
		const content = { hooks: { Stop: { odd: true }, Other: "x" } };
		world.seed(world.paths.claude, content);
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
		]);
		expect(result.code).toBe(0);
		const after = world.readJson<{ hooks: Record<string, unknown> }>(
			world.paths.claude,
		);
		expect(after.hooks.Stop).toEqual(content.hooks.Stop);
		expect(after.hooks.Other).toEqual(content.hooks.Other);
		expect(ownedObjects(after as SettingsFile)).toHaveLength(1);
		const status = JSON.parse((await world.cli(["status", "--json"])).stdout);
		expect(status.runtimes.claude.enabled).toEqual(["spelling"]);
		await world.cli(["disable", "--all", "--runtime", "claude"]);
		expect(
			world.readJson<{ hooks: unknown }>(world.paths.claude).hooks,
		).toEqual(content.hooks);
	});

	test.each([
		["hooks is a string", { hooks: "x" }],
		["an event is not an array", { hooks: { PostToolUse: {} } }],
	])("refuses with exit 1 and no write when %s", async (_name, content) => {
		world.seed(world.paths.claude, content);
		const before = world.text(world.paths.claude);
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
		]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("must be");
		expect(world.text(world.paths.claude)).toBe(before);
	});

	test("a UTF-8 BOM in settings.json is accepted", async () => {
		world.seed(
			world.paths.claude,
			`\uFEFF${JSON.stringify({ theme: "dark" })}`,
		);
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
		]);
		expect(result.code).toBe(0);
		expect(world.readJson(world.paths.claude).theme).toBe("dark");
	});

	test("enable twice leaves one object", async () => {
		world.seed(world.paths.claude, userSettings());
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		const once = world.text(world.paths.claude);
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		expect(ownedObjects(world.readJson(world.paths.claude))).toHaveLength(1);
		expect(world.text(world.paths.claude)).toBe(once);
	});

	test("writes 2-space JSON", async () => {
		world.seed(world.paths.claude, { theme: "dark" });
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		const parsed = world.readJson(world.paths.claude);
		expect(world.text(world.paths.claude).trimEnd()).toBe(
			JSON.stringify(parsed, null, 2),
		);
	});

	test("disable removes only the owned object and drops the emptied group", async () => {
		world.seed(world.paths.claude, { theme: "dark" });
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		await world.cli(["disable", "spelling", "--runtime", "claude"]);
		const after = world.readJson(world.paths.claude);
		expect(after.theme).toBe("dark");
		expect(ownedObjects(after)).toEqual([]);
		expect(after.hooks?.PostToolUse ?? []).toEqual([]);
	});

	test("disable keeps a shared group that still holds a user hook", async () => {
		const before = userSettings();
		world.seed(world.paths.claude, before);
		await world.cli(["enable", "spelling", "--runtime", "claude"]);
		await world.cli(["disable", "spelling", "--runtime", "claude"]);
		expect(world.readJson(world.paths.claude)).toEqual(before);
	});

	test("never touches a user hook that merely mentions hooks run", async () => {
		const decoy = {
			type: "command",
			command: "echo dg-skills hooks run spelling && true",
		};
		const before: SettingsFile = {
			hooks: { PostToolUse: [{ matcher: MATCHER, hooks: [decoy] }] },
		};
		world.seed(world.paths.claude, before);
		await world.cli(["disable", "--all"]);
		expect(world.readJson(world.paths.claude)).toEqual(before);
	});

	test("invalid JSON aborts with exit 1 and no write", async () => {
		const bad = '{ "hooks": [oops';
		world.seed(world.paths.claude, bad);
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"claude",
		]);
		expect(result.code).toBe(1);
		expect(world.text(world.paths.claude)).toBe(bad);
		expect(result.stdout).not.toContain("enabled");
	});
});

describe("codex settings writer", () => {
	test("enable writes the owned object into ~/.codex/hooks.json without touching user hooks", async () => {
		const before = userSettings();
		world.seed(world.paths.codex, before);
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"codex",
		]);
		expect(result.code).toBe(0);
		const after = world.readJson(world.paths.codex);
		expect(ownedObjects(after)).toHaveLength(1);
		const expected = structuredClone(before);
		expected.hooks?.PostToolUse?.[1]?.hooks.push({
			type: "command",
			command: ownedCommand(world.launcher, "spelling"),
		});
		expect(after).toEqual(expected);
		expect(result.stdout).toContain(
			"codex: enabled spelling (takes effect in new sessions)",
		);
	});

	test("invalid JSON in hooks.json aborts with exit 1 and no write", async () => {
		world.seed(world.paths.codex, "nope");
		const result = await world.cli([
			"enable",
			"spelling",
			"--runtime",
			"codex",
		]);
		expect(result.code).toBe(1);
		expect(world.text(world.paths.codex)).toBe("nope");
	});
});
