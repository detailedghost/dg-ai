import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DgCliError } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { launchChrome } from "../src/channel-review/connect";
import { registerDemo } from "../src/commands/demo";
import { ensureNarrationAssets } from "../src/demo/narration-assets";
import { launchLocal } from "../src/demo/player-process";
import { type DemoResult, writeResult } from "../src/demo/result";
import { savePlan } from "../src/demo/plan-file";
import { runInbox } from "../src/inbox/cli";
import { runSkillsOnlyInstall } from "../src/install/skills-only";
import { installBrowser } from "../src/pw/browsers";
import { scrapePrototype } from "../src/proto/cli";
import { runSsmsCommand } from "../src/ssms/cli";
import { setCliOnly } from "../src/utils/cli-only";
import { type DemoWorld, demoWorld, TWO_STEP_PLAN } from "./demo-local-fixtures";

const posix = describe.skipIf(process.platform === "win32");

let world: DemoWorld;
let savedScratch: string | undefined;
let savedPath: string | undefined;

function legacy(name: string): void {
	const file = join(world.stateDir, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "old");
}

beforeEach(() => {
	world = demoWorld();
	savedScratch = process.env.AI_SCRATCH_DIR;
	savedPath = process.env.PATH;
	delete process.env.AI_SCRATCH_DIR;
});

afterEach(() => {
	if (savedScratch === undefined) delete process.env.AI_SCRATCH_DIR;
	else process.env.AI_SCRATCH_DIR = savedScratch;
	process.env.PATH = savedPath;
	world.cleanup();
});

const REPO = join(import.meta.dir, "..", "..", "..");

posix("dg-skills writers refuse an unmoved legacy entry", () => {
	test("setCliOnly creates no cli-only marker while the legacy marker holds data", () => {
		legacy("cli-only");

		expect(() => setCliOnly(true)).toThrow(DgCliError);
		expect(existsSync(resolveDgPaths().cliOnlyMarker)).toBe(false);
	});

	test("a skills-only install writes no skills folder while the legacy skills folder holds data", () => {
		legacy("skills/dg/SKILL.md");
		const paths = resolveDgPaths();

		expect(() => runSkillsOnlyInstall({ repo: undefined, dest: undefined, repoRoot: REPO })).toThrow(DgCliError);
		expect(existsSync(paths.skillsDir)).toBe(false);
		expect(existsSync(paths.personasDir)).toBe(false);
	});

	test("a skills-only install writes no personas folder while the legacy agents folder holds data", () => {
		legacy("agents/memory.db");
		const paths = resolveDgPaths();

		expect(() => runSkillsOnlyInstall({ repo: undefined, dest: undefined, repoRoot: REPO })).toThrow(DgCliError);
		expect(existsSync(paths.skillsDir)).toBe(false);
		expect(existsSync(paths.personasDir)).toBe(false);
	});

	test("installBrowser writes no browsers folder while the legacy browsers folder holds data", async () => {
		legacy("browsers/chromium/chrome");

		const attempt = installBrowser(async () => ({ version: "1", executablePath: "/x" }));

		await expect(attempt).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(resolveDgPaths().browsersDir)).toBe(false);
	});

	test("ensureNarrationAssets writes no demo-narration folder and fetches nothing while the legacy folder holds data", async () => {
		legacy("demo-narration/1.0.0/kokoro.js");
		const offline = (async () => {
			throw new Error("the network must not be used");
		}) as unknown as typeof fetch;

		const attempt = ensureNarrationAssets("1.0.0", { fetch: offline });

		await expect(attempt).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(join(resolveDgPaths().dataDir, "demo-narration"))).toBe(false);
	});

	test("writeResult and savePlan write no demos folder while the legacy demos folder holds data", () => {
		legacy("demos/tour/tour.demo.md");
		const result: DemoResult = {
			slug: "tour",
			outcome: "done",
			mode: "video",
			encoded: false,
			audio: "none",
			steps: 1,
			plan: "p",
			startedAt: "a",
			endedAt: "b",
		};

		expect(() => writeResult(result)).toThrow(DgCliError);
		expect(() => savePlan(TWO_STEP_PLAN)).toThrow(DgCliError);
		expect(existsSync(join(resolveDgPaths().cacheDir, "demos"))).toBe(false);
	});

	test("demo <plan> writes no demos folder and spawns no player while the legacy demos folder holds data", async () => {
		legacy("demos/tour/tour.demo.md");
		const deps = {
			play: async () => {
				throw new Error("the extension path must not run");
			},
			local: world.localDeps(),
		};

		await expect(world.drive(registerDemo, ["demo", world.planPath], deps)).rejects.toBeInstanceOf(DgCliError);
		expect(world.spawned).toHaveLength(0);
		expect(existsSync(world.demosDir)).toBe(false);
	});

	test("launchLocal creates no demo-profile folder while the legacy folder holds data", async () => {
		legacy("demo-profile/Default/Preferences");
		const job = { dir: world.home } as unknown as Parameters<typeof launchLocal>[0];
		const plan = { mode: "local", headless: true, pick: { channel: "chrome" }, label: "chrome" } as Parameters<typeof launchLocal>[1];

		await expect(launchLocal(job, plan)).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(join(resolveDgPaths().stateDir, "demo-profile"))).toBe(false);
	});

	test("launchChrome creates no browser-profiles folder while the legacy folder holds data", async () => {
		legacy("browser-profiles/connect/Default/Preferences");

		await expect(launchChrome()).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(join(resolveDgPaths().stateDir, "browser-profiles"))).toBe(false);
	});

	test("scrapePrototype creates no proto folder while the legacy proto folder holds data", async () => {
		legacy("proto/example/style-guide.json");

		await expect(scrapePrototype("https://example.test/")).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(join(resolveDgPaths().cacheDir, "proto"))).toBe(false);
	});

	test("an inbox workflow creates no inbox folder while the legacy inbox folder holds data", async () => {
		legacy("inbox/config/token.json");

		await expect(runInbox(["no-such-workflow"])).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(join(resolveDgPaths().stateDir, "inbox"))).toBe(false);
	});

	test("an ssms command creates no ssms folder while the legacy ssms folder holds data", async () => {
		legacy("ssms/config.yaml");
		process.env.PATH = world.home;

		await expect(runSsmsCommand(["signal", "status"])).rejects.toBeInstanceOf(DgCliError);
		expect(existsSync(join(resolveDgPaths().stateDir, "ssms"))).toBe(false);
	});

	test("an ssms help request runs while the legacy ssms folder holds data", async () => {
		legacy("ssms/config.yaml");

		expect(await runSsmsCommand(["--help"])).toBe(0);
	});
});
