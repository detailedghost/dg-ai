import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	bootstrapCommand,
	installCommand,
	upgradeCommand,
} from "../src/doctor/checks";
import { createContext } from "../src/doctor/runner";
import { sharedChecks } from "../src/doctor/shared";
import { compareVersions, versionGte } from "../src/utils/lib";
import { doctorWorld } from "./doctor-fixtures";

let world: ReturnType<typeof doctorWorld>;

beforeEach(() => {
	world = doctorWorld();
});

afterEach(() => world.cleanup());

function context() {
	return createContext({ home: world.home, env: world.env() });
}

describe("doctor install and upgrade hints", () => {
	test.each([
		["linux", "sudo apt-get install -y git"],
		["darwin", "brew install git"],
		["win32", "winget install Git.Git"],
	] as const)("installs git on %s", (platform, expected) => {
		expect(installCommand("git", platform)).toBe(expected);
	});

	test.each([
		["linux", "sudo apt-get install --only-upgrade -y git"],
		["darwin", "brew upgrade git"],
		["win32", "winget upgrade Git.Git"],
	] as const)("upgrades git on %s", (platform, expected) => {
		expect(upgradeCommand("git", platform)).toBe(expected);
	});

	test("a tool without a platform hint gets a plain-words hint, not a probe", () => {
		expect(installCommand("xclip", "darwin")).toContain("install xclip");
		expect(installCommand("no-such-tool", "linux")).toContain(
			"install no-such-tool",
		);
		expect(upgradeCommand("no-such-tool", "linux")).not.toContain("command -v");
	});

	test("a package-manager-neutral tool uses the same command everywhere", () => {
		expect(installCommand("codex", "win32")).toBe(
			installCommand("codex", "linux"),
		);
	});
});

describe("doctor bootstrap command", () => {
	test("uses the shell script off Windows and the PowerShell script on it", () => {
		const ctx = context();
		expect(bootstrapCommand("1.2.3", ctx, "linux")).toContain("bootstrap.sh | sh");
		expect(bootstrapCommand("1.2.3", ctx, "win32")).toBe(
			"irm https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.2.3/pkg/skills-cli/bootstrap.ps1 | iex",
		);
	});

	test("a CLI-only install keeps the CLI-only form on both platforms", () => {
		const ctx = context();
		mkdirSync(ctx.paths.stateDir, { recursive: true });
		writeFileSync(join(ctx.paths.stateDir, "cli-only"), "");
		expect(bootstrapCommand("1.2.3", ctx, "linux")).toEndWith("-s -- --cli-only");
		expect(bootstrapCommand("1.2.3", ctx, "win32")).toStartWith(
			'$env:DG_CLI_ONLY = "1"; irm ',
		);
	});
});

describe("doctor shared root fix", () => {
	test("quotes a path that contains a single quote", async () => {
		const blocker = join(world.home, "it's a file");
		writeFileSync(blocker, "");
		const ctx = createContext({
			home: world.home,
			env: { HOME: world.home, AI_STATE_DIR: join(blocker, "state") },
		});
		const check = sharedChecks.find((entry) => entry.id === "state-root");
		const result = await check?.run(ctx);
		expect(result?.fix).toContain("it'\\''s a file");
	});
});

describe("version ordering", () => {
	test("orders dotted versions and ignores a leading v", () => {
		expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compareVersions("v2.0", "2.0.0")).toBe(0);
		expect(compareVersions("1.0.0", "1.0.1")).toBeLessThan(0);
		expect(versionGte("2.17.0", "2.17.0")).toBe(true);
		expect(versionGte("2.16.9", "2.17.0")).toBe(false);
	});
});
