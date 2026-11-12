import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { slugify } from "@dg/common";
import { selfCommand } from "@dg/common/node";
import { BrowserMissingError } from "../src/pw/core/browser";
import { registerDemo } from "../src/commands/demo";
import { playLocal } from "../src/demo/local";
import { DEFAULT_TIMEOUT_MIN } from "../src/demo/player-job";
import { loadScript } from "../src/demo/plan-file";
import { type DemoWorld, demoWorld } from "./demo-local-fixtures";

let world: DemoWorld;

beforeEach(() => {
	world = demoWorld();
});
afterEach(() => {
	world.cleanup();
});

const headless = () => ({
	isWSL: () => true,
	windowsBrowserPresent: () => false,
});

function playerJob(index = 0): Record<string, unknown> {
	const argv = world.spawned[index]?.argv ?? [];
	return JSON.parse(argv[argv.length - 1] ?? "null");
}

function demoDeps(over: Parameters<DemoWorld["localDeps"]>[0] = {}) {
	return {
		play: async () => {
			throw new Error("the extension path must not run");
		},
		local: world.localDeps(over),
	};
}

describe("demo <plan> local default", () => {
	test("spawns the detached player once and prints the recording line", async () => {
		const run = await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		expect(run.code).toBe(0);
		expect(world.spawned).toHaveLength(1);
		const { argv } = world.spawned[0]!;
		expect(argv.slice(0, -3)).toEqual(selfCommand([]));
		expect(argv.slice(-3, -1)).toEqual(["demo", "player"]);
		expect(typeof playerJob().slug).toBe("string");
		expect(run.out).toContain("recording in");
		expect(run.out).toContain(`dg-skills demo status ${playerJob().slug}`);
	});

	test("saves the plan under the demos dir and logs the player next to it", async () => {
		await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		const slug = String(playerJob().slug);
		const planFile = join(world.demosDir, slug, `${slug}.demo.md`);
		expect(existsSync(planFile)).toBe(true);
		expect(loadScript(planFile).steps).toHaveLength(
			loadScript(world.planPath).steps.length,
		);
		const logPath = String(world.spawned[0]?.logPath);
		expect(dirname(logPath)).toBe(join(world.demosDir, slug));
		expect(basename(logPath)).toMatch(/^player-.+\.log$/);
	});

	test("gives each run its own log file", async () => {
		await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		expect(world.spawned).toHaveLength(2);
		expect(world.spawned[0]?.logPath).not.toBe(world.spawned[1]?.logPath);
	});

	test("accepts --video and always records", async () => {
		const run = await world.drive(registerDemo, ["demo", "--video", world.planPath], demoDeps());
		expect(run.code).toBe(0);
		expect(run.out).toContain("recording in");
		expect(playerJob()).not.toHaveProperty("video");
	});
});

describe("demo <plan> with a headless browser plan", () => {
	const withSetup = (value: string) => {
		const plan = JSON.parse(readFileSync(world.planPath, "utf8"));
		const file = join(dirname(world.planPath), "setup.json");
		writeFileSync(
			file,
			JSON.stringify({
				...plan,
				setup: {
					includeInTour: false,
					steps: [
						{ title: "Password", body: "Sign in.", selector: "#pw", action: { do: "fill", value } },
					],
				},
			}),
		);
		return file;
	};

	afterEach(() => {
		delete process.env.DG_DEMO_LOCAL_PW;
	});

	test("records unattended with no flag", async () => {
		const run = await world.drive(registerDemo, ["demo", world.planPath], demoDeps(headless()));
		expect(run.code).toBe(0);
		expect(world.spawned).toHaveLength(1);
		expect((playerJob().plan as { headless: boolean }).headless).toBe(true);
	});

	test("exits 2 when excluded setup needs a person to type an unset variable", async () => {
		delete process.env.DG_DEMO_LOCAL_PW;
		const run = await world.drive(
			registerDemo,
			["demo", withSetup("$DG_DEMO_LOCAL_PW")],
			demoDeps(headless()),
		);
		expect(run.code).toBe(2);
		expect(run.err).toContain("setup steps that need a person");
		expect(world.spawned).toHaveLength(0);
	});

	test("exits 2 in the foreground when a recorded step names an unset variable", async () => {
		delete process.env.DG_DEMO_LOCAL_PW;
		const plan = JSON.parse(readFileSync(world.planPath, "utf8"));
		const file = join(dirname(world.planPath), "recorded-login.json");
		writeFileSync(
			file,
			JSON.stringify({
				...plan,
				steps: [...plan.steps, { title: "Password", body: "Sign in.", selector: "#pw", action: { do: "fill", value: "$DG_DEMO_LOCAL_PW" } }],
			}),
		);
		const run = await world.drive(registerDemo, ["demo", file], demoDeps(headless()));
		expect(run.code).toBe(2);
		expect(run.err).toContain("demo: set $DG_DEMO_LOCAL_PW or move the login to ## Setup");
		expect(world.spawned).toHaveLength(0);
	});

	test("runs setup unattended when its variable is set", async () => {
		process.env.DG_DEMO_LOCAL_PW = "x";
		const run = await world.drive(
			registerDemo,
			["demo", withSetup("$DG_DEMO_LOCAL_PW")],
			demoDeps(headless()),
		);
		expect(run.code).toBe(0);
		expect(world.spawned).toHaveLength(1);
	});

	test("spawns the player with --wsl-headed", async () => {
		const run = await world.drive(
			registerDemo,
			["demo", "--wsl-headed", world.planPath],
			demoDeps(headless()),
		);
		expect(run.code).toBe(0);
		expect(world.spawned).toHaveLength(1);
	});
});

describe("demo <plan> with no browser at all", () => {
	test("exits 3 with the install-browser message and starts nothing", async () => {
		const run = await world.drive(
			registerDemo,
			["demo", world.planPath],
			demoDeps({
				pickLaunch: () => {
					throw new BrowserMissingError();
				},
			}),
		);
		expect(run.code).toBe(3);
		expect(run.err).toContain("dg-skills pw install-browser");
		expect(world.spawned).toHaveLength(0);
	});
});

describe("demo --print and --edit", () => {
	test.each(["--print", "--edit"])("%s without --ext exits 1 naming --ext", async (flag) => {
		const run = await world.drive(registerDemo, ["demo", flag, world.planPath], demoDeps());
		expect(run.code).toBe(1);
		expect(run.err).toContain("--print/--edit need --ext");
		expect(world.spawned).toHaveLength(0);
	});

	test.each(["print", "edit"] as const)("playLocal refuses %s on its own and starts nothing", async (flag) => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => void errors.push(args.join(" "));
		try {
			const code = await playLocal(loadScript(world.planPath), { [flag]: true }, world.localDeps());
			expect(code).toBe(1);
		} finally {
			console.error = original;
		}
		expect(errors.join("\n")).toContain("--print/--edit need --ext");
		expect(world.spawned).toHaveLength(0);
	});

	test.each(["--print", "--edit"])("%s with --ext calls playScript", async (flag) => {
		const played: Array<Record<string, unknown>> = [];
		const run = await world.drive(registerDemo, ["demo", "--ext", flag, world.planPath], {
			play: async (_script: unknown, opts: Record<string, unknown>) =>
				void played.push(opts),
			local: world.localDeps(),
		});
		expect(run.code).toBe(0);
		expect(played).toHaveLength(1);
		expect(played[0]?.ext).toBe(true);
		expect(played[0]?.[flag.slice(2)]).toBe(true);
		expect(world.spawned).toHaveLength(0);
	});

	test("--ext without a flag plays through playScript, not the local player", async () => {
		const played: unknown[] = [];
		await world.drive(registerDemo, ["demo", "--ext", world.planPath], {
			play: async (script: unknown) => void played.push(script),
			local: world.localDeps(),
		});
		expect(played).toHaveLength(1);
		expect(world.spawned).toHaveLength(0);
	});
});

describe("saved plan readability", () => {
	test("the saved plan file loads back to the same title", async () => {
		await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		const slug = String(playerJob().slug);
		const saved = loadScript(join(world.demosDir, slug, `${slug}.demo.md`));
		expect(saved.title).toBe(loadScript(world.planPath).title);
	});
});

describe("demo <plan> player job", () => {
	test("carries the fixed job fields", async () => {
		await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		const job = playerJob();
		const slug = String(job.slug);
		const dir = join(world.demosDir, slug);
		const script = loadScript(world.planPath);
		expect(job.dir).toBe(dir);
		expect(job.planPath).toBe(join(dir, `${slug}.demo.md`));
		expect(job.startUrl).toBe(script.startUrl);
		expect(job.script).toBeUndefined();
		expect(loadScript(String(job.planPath)).steps).toHaveLength(script.steps.length);
		expect(job.timeoutMin).toBe(DEFAULT_TIMEOUT_MIN);
		expect(job.out).toBeUndefined();
		expect(job.plan).toEqual({
			mode: "local",
			headless: false,
			pick: { channel: "chrome" },
			label: "chrome",
		});
	});

	test("--timeout and --out override the defaults", async () => {
		await world.drive(
			registerDemo,
			["demo", "--timeout", "5", "--out", "/tmp/x.mp4", world.planPath],
			demoDeps(),
		);
		expect(playerJob().timeoutMin).toBe(5);
		expect(playerJob().out).toBe("/tmp/x.mp4");
	});

	test.each(["0", "-3", "abc"])("rejects a non-positive --timeout %s", async (value) => {
		const run = await world.drive(
			registerDemo,
			["demo", "--timeout", value, world.planPath],
			demoDeps(),
		).catch((error: Error) => ({ code: 1, out: "", err: String(error.message) }));
		expect(run.code).not.toBe(0);
		expect(world.spawned).toHaveLength(0);
	});

	test("writes player.pid with the spawned pid", async () => {
		await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		const slug = String(playerJob().slug);
		expect(readFileSync(join(world.demosDir, slug, "player.pid"), "utf8")).toBe("4242");
	});

	test("a spawn failure surfaces and leaves no player.pid", async () => {
		const run = await world
			.drive(
				registerDemo,
				["demo", world.planPath],
				demoDeps({
					spawn: () => {
						throw new Error("spawn boom");
					},
				}),
			)
			.catch((error: Error) => ({ code: 1, out: "", err: error.message }));
		expect(run.code).not.toBe(0);
		expect(run.err).toContain("spawn boom");
		const slug = slugify(loadScript(world.planPath).title ?? "demo");
		expect(existsSync(join(world.demosDir, slug, "player.pid"))).toBe(false);
	});
});

describe("demo <plan> browser selection", () => {
	test("--wsl-headed turns a headless WSL plan visible", async () => {
		await world.drive(
			registerDemo,
			["demo", "--wsl-headed", world.planPath],
			demoDeps(headless()),
		);
		const plan = playerJob().plan as { mode: string; headless: boolean };
		expect(plan.mode).toBe("local");
		expect(plan.headless).toBe(false);
	});

	test("--windows plans the Windows browser", async () => {
		const run = await world.drive(
			registerDemo,
			["demo", "--windows", world.planPath],
			demoDeps({ isWSL: () => true, windowsBrowserPresent: () => true }),
		);
		expect(run.code).toBe(0);
		expect((playerJob().plan as { mode: string }).mode).toBe("windows");
		expect(run.out).toContain("Windows");
	});

	test("--windows with no Windows browser exits 3 and starts nothing", async () => {
		const run = await world.drive(
			registerDemo,
			["demo", "--windows", world.planPath],
			demoDeps({ isWSL: () => true, windowsBrowserPresent: () => false }),
		);
		expect(run.code).toBe(3);
		expect(run.err).toContain("dg-skills pw install-browser");
		expect(world.spawned).toHaveLength(0);
	});

	test("--windows off WSL exits 1 and starts nothing", async () => {
		const run = await world.drive(registerDemo, ["demo", "--windows", world.planPath], demoDeps());
		expect(run.code).toBe(1);
		expect(run.err).toContain("needs WSL");
		expect(world.spawned).toHaveLength(0);
	});

	test("--windows with --browser chromium exits 1 and starts nothing", async () => {
		const run = await world.drive(
			registerDemo,
			["demo", "--windows", "--browser", "chromium", world.planPath],
			demoDeps({ isWSL: () => true, windowsBrowserPresent: () => true }),
		);
		expect(run.code).toBe(1);
		expect(run.err).toContain("--browser chrome");
		expect(world.spawned).toHaveLength(0);
	});

	test("refuses a second run of the same demo while its player is live", async () => {
		await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		const slug = String(playerJob().slug);
		const live = Bun.spawn(
			[process.execPath, "-e", "setInterval(() => {}, 1000)", "--", "player", JSON.stringify({ slug })],
			{ stdout: "ignore", stderr: "ignore", stdin: "ignore" },
		);
		try {
			writeFileSync(join(world.demosDir, slug, "player.pid"), String(live.pid));
			const run = await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
			expect(run.code).toBe(1);
			expect(run.err).toContain(`a player for ${slug} is already running (pid ${live.pid})`);
			expect(world.spawned).toHaveLength(1);
		} finally {
			live.kill();
		}
	});

	test("--out must name a .mp4 file", async () => {
		const run = await world.drive(
			registerDemo,
			["demo", "--out", "/tmp/x.webm", world.planPath],
			demoDeps(),
		);
		expect(run.code).toBe(1);
		expect(run.err).toContain(".mp4");
		expect(world.spawned).toHaveLength(0);
	});

	test("--out inside a git work tree exits 1 and starts nothing", async () => {
		const checked: string[] = [];
		const out = join(world.home, "not-yet", "deeper", "x.mp4");
		const run = await world.drive(
			registerDemo,
			["demo", "--out", out, world.planPath],
			demoDeps({
				inGitWorkTree: (dir) => {
					checked.push(dir);
					return true;
				},
			}),
		);
		expect(run.code).toBe(1);
		expect(run.err).toContain("demo: --out must be outside a git work tree");
		expect(checked).toEqual([realpathSync(world.home)]);
		expect(world.spawned).toHaveLength(0);
	});

	test("--out checks the real path of a symlinked parent", async () => {
		const real = join(world.home, "real");
		mkdirSync(real);
		symlinkSync(real, join(world.home, "link"));
		const checked: string[] = [];
		const run = await world.drive(
			registerDemo,
			["demo", "--out", join(world.home, "link", "x.mp4"), world.planPath],
			demoDeps({ inGitWorkTree: (dir) => (checked.push(dir), true) }),
		);
		expect(run.code).toBe(1);
		expect(checked).toEqual([realpathSync(real)]);
	});

	test("--out that is itself a symlink is refused, even when it dangles", async () => {
		const target = join(world.home, "in-repo.mp4");
		const link = join(world.home, "out.mp4");
		symlinkSync(target, link);
		const run = await world.drive(registerDemo, ["demo", "--out", link, world.planPath], demoDeps());
		expect(run.code).toBe(1);
		expect(run.err).toContain("demo: --out must not be a symlink");
		expect(world.spawned).toHaveLength(0);
	});

	test("--out is passed to the player as an absolute path", async () => {
		const previous = process.cwd();
		process.chdir(world.home);
		try {
			await world.drive(registerDemo, ["demo", "--out", "rel/x.mp4", world.planPath], demoDeps());
		} finally {
			process.chdir(previous);
		}
		expect(playerJob().out).toBe(join(realpathSync(world.home), "rel", "x.mp4"));
	});

	test("--out outside a git work tree is passed to the player", async () => {
		const out = join(world.home, "x.mp4");
		await world.drive(registerDemo, ["demo", "--out", out, world.planPath], demoDeps());
		expect(playerJob().out).toBe(out);
	});

	test("local-only flags with --ext exit 1 and name local mode", async () => {
		const run = await world.drive(
			registerDemo,
			["demo", "--ext", "--out", "/tmp/x.mp4", world.planPath],
			demoDeps(),
		);
		expect(run.code).toBe(1);
		expect(run.err).toContain("--out need local mode");
	});

	test("keeps the saved plan, the log and the dir private", async () => {
		await world.drive(registerDemo, ["demo", world.planPath], demoDeps());
		const slug = String(playerJob().slug);
		const dir = join(world.demosDir, slug);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, `${slug}.demo.md`)).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "player.pid")).mode & 0o777).toBe(0o600);
	});

	test("--browser keeps a WSL run headless inside WSL even with a Windows browser", async () => {
		await world.drive(
			registerDemo,
			["demo", "--browser", "chrome", world.planPath],
			demoDeps({ isWSL: () => true, windowsBrowserPresent: () => true }),
		);
		expect(playerJob().plan).toMatchObject({ mode: "local", headless: true });
	});

	test("a Windows browser on WSL with no flags plans the Windows browser", async () => {
		await world.drive(
			registerDemo,
			["demo", world.planPath],
			demoDeps({ isWSL: () => true, windowsBrowserPresent: () => true }),
		);
		expect((playerJob().plan as { mode: string }).mode).toBe("windows");
	});

	test.each(["chrome", "msedge"])("--browser %s picks that channel", async (name) => {
		await world.drive(registerDemo, ["demo", "--browser", name, world.planPath], demoDeps());
		const plan = playerJob().plan as { pick: unknown; label: string };
		expect(plan.pick).toEqual({ channel: name });
		expect(plan.label).toBe(name);
	});

	test("--browser chromium without a downloaded build exits 3 and starts nothing", async () => {
		const run = await world.drive(
			registerDemo,
			["demo", "--browser", "chromium", world.planPath],
			demoDeps(),
		);
		expect(run.code).toBe(3);
		expect(run.err).toContain("dg-skills pw install-browser");
		expect(world.spawned).toHaveLength(0);
	});
});
