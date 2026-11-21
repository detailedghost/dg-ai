import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { relaunchHooks } from "../../src/hooks/relaunch";
import { ownedCommand } from "../../src/hooks/settings/marker";
import { ownedObjects, settingsWorld, USER_HOOK } from "../hooks-settings/settings-fixtures";

let world: ReturnType<typeof settingsWorld>;
let oldLauncher: string;
let newLauncher: string;

beforeEach(() => {
	world = settingsWorld();
	oldLauncher = join(world.dgHome, "bin", "dg-skills");
	newLauncher = join(world.dgHome, "bin", "dg");
});
afterEach(() => world.cleanup());

const enableOld = (...argv: string[]) => world.cli(["enable", ...argv], { launcher: oldLauncher });
const commandsOf = (file: string): string[] => ownedObjects(world.readJson(file)).map((hook) => hook.command ?? "");

describe("relaunchHooks", () => {
	test("rewrites Claude hook commands that run dg-skills to the new launcher and keeps user hooks", async () => {
		world.seed(world.paths.claude, { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [USER_HOOK] }] } });
		await enableOld("spelling", "format", "--runtime", "claude");

		const changed = await relaunchHooks(newLauncher, world.home, {});

		expect(changed).toEqual(["claude"]);
		const commands = commandsOf(world.paths.claude);
		expect(commands.sort()).toEqual([ownedCommand(newLauncher, "format"), ownedCommand(newLauncher, "spelling")].sort());
		expect(world.text(world.paths.claude)).toContain(USER_HOOK.command ?? "");
		expect(world.text(world.paths.claude)).not.toContain("dg-skills");
	});

	test("rewrites Codex hook commands", async () => {
		await enableOld("spelling", "--runtime", "codex");

		const changed = await relaunchHooks(newLauncher, world.home, {});

		expect(changed).toEqual(["codex"]);
		expect(commandsOf(world.paths.codex)).toEqual([ownedCommand(newLauncher, "spelling")]);
	});

	test("rewrites the OpenCode plugin commands", async () => {
		world.seed(world.paths.opencodeJson, {});
		await enableOld("spelling", "--runtime", "opencode");

		const changed = await relaunchHooks(newLauncher, world.home, {});

		expect(changed).toEqual(["opencode"]);
		const plugin = world.text(world.paths.opencodePlugin);
		expect(plugin).toContain(ownedCommand(newLauncher, "spelling"));
		expect(plugin).not.toContain(oldLauncher);
	});

	test("a second run changes nothing", async () => {
		await enableOld("spelling", "--runtime", "claude");
		await relaunchHooks(newLauncher, world.home, {});
		const before = world.text(world.paths.claude);

		const changed = await relaunchHooks(newLauncher, world.home, {});

		expect(changed).toEqual([]);
		expect(world.text(world.paths.claude)).toBe(before);
	});

	test("leaves commands that already run dg and commands that are not dg untouched", async () => {
		world.seed(world.paths.claude, {
			hooks: {
				PostToolUse: [
					{ matcher: "Bash", hooks: [USER_HOOK, { type: "command", command: "echo dg-skills hooks run spelling && true" }] },
				],
			},
		});
		await world.cli(["enable", "format", "--runtime", "codex"], { launcher: newLauncher });
		const claudeBefore = world.text(world.paths.claude);
		const codexBefore = world.text(world.paths.codex);

		const changed = await relaunchHooks(newLauncher, world.home, {});

		expect(changed).toEqual([]);
		expect(world.text(world.paths.claude)).toBe(claudeBefore);
		expect(world.text(world.paths.codex)).toBe(codexBefore);
	});

	test("writes nothing when no settings file exists", async () => {
		const changed = await relaunchHooks(newLauncher, world.home, {});

		expect(changed).toEqual([]);
		expect(world.has(world.paths.claude)).toBe(false);
		expect(world.has(world.paths.codex)).toBe(false);
		expect(world.has(world.paths.opencodePlugin)).toBe(false);
	});

	test("warns for a runtime it cannot read and still rewrites the others", async () => {
		await enableOld("spelling", "--runtime", "claude");
		world.seed(world.paths.codex, "{ not json");
		const warnings: string[] = [];

		const changed = await relaunchHooks(newLauncher, world.home, {}, (line) => void warnings.push(line));

		expect(changed).toEqual(["claude"]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("the codex hooks still run dg-skills");
		expect(warnings[0]).toContain("run dg hooks enable again");
		expect(world.text(world.paths.codex)).toBe("{ not json");
	});

	test("follows CODEX_HOME for the Codex hooks file", async () => {
		const codexHome = join(world.home, "elsewhere");
		await world.cli(["enable", "spelling", "--runtime", "codex"], { launcher: oldLauncher, env: { CODEX_HOME: codexHome } });

		const changed = await relaunchHooks(newLauncher, world.home, { CODEX_HOME: codexHome });

		expect(changed).toEqual(["codex"]);
		expect(commandsOf(join(codexHome, "hooks.json"))).toEqual([ownedCommand(newLauncher, "spelling")]);
	});
});
