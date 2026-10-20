import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { shellCommand } from "../src/utils/self-command";
import { mergeEnv } from "./module-call";
import {
	freePort,
	installFakeViewer,
	installRealVizSkill,
	newVizWorld,
	readStarts,
	runVizBinary,
	SESSION_ID,
	sessionPayloadPath,
	stopStartedServers,
	type VizWorld,
	vizEnv,
	writePayload,
} from "./viz-fixtures";

function installLines(log: string): string[] {
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => /\|install( |$)/.test(line));
}

let world: VizWorld;
let binary: string;
let port: number;
let env: Record<string, string>;

function viz(args: string[], extra: Record<string, string | undefined> = {}) {
	return runVizBinary(binary, world, args, mergeEnv({ ...env, ...extra }));
}

beforeAll(() => {
	world = newVizWorld();
	binary = join(world.base, "moved ' install", "dg-skills");
	mkdirSync(dirname(binary), { recursive: true });
	const build = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../build.ts"),
			"--outfile",
			binary,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}, 240_000);

afterAll(() => rmSync(world.base, { recursive: true, force: true }));

beforeEach(() => {
	port = freePort();
	env = vizEnv(world, port);
});

afterEach(async () => {
	await stopStartedServers(binary, world, env);
	rmSync(join(world.skills, "viz"), { recursive: true, force: true });
	rmSync(join(world.home, ".claude"), { recursive: true, force: true });
});

describe("dg-skills viz render from a relocated binary", () => {
	test("renders a payload, starts the viewer once and prints the session URL and payload path", async () => {
		installFakeViewer(world, true);
		const run = await viz([
			"render",
			"--input",
			writePayload(world),
			"--no-open",
		]);
		expect(run.exitCode).toBe(0);
		const slug = `demo-${SESSION_ID}`;
		expect(run.stdout).toBe(
			`VIZ_URL=http://localhost:${port}/viz/${slug}\nVIZ_PATH=${sessionPayloadPath(world)}\n`,
		);
		expect(
			JSON.parse(readFileSync(sessionPayloadPath(world), "utf8")).slug,
		).toBe(slug);
		expect(readStarts(world)).toHaveLength(1);
	});

	test("a bare --input with no subcommand still renders", async () => {
		installFakeViewer(world, true);
		const run = await viz(["--input", writePayload(world), "--no-open"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("VIZ_URL=");
	});

	test("a second render reuses the running viewer instead of starting another", async () => {
		installFakeViewer(world, true);
		const payload = writePayload(world);
		expect(
			(await viz(["render", "--input", payload, "--no-open"])).exitCode,
		).toBe(0);
		expect(
			(await viz(["render", "--input", payload, "--no-open"])).exitCode,
		).toBe(0);
		expect(readStarts(world)).toHaveLength(1);
	});

	test("help and unrelated verbs never start the viewer", async () => {
		installFakeViewer(world, true);
		const help = await viz(["--help"]);
		expect(help.exitCode).toBe(0);
		const list = await viz(["list"]);
		expect(list.exitCode).toBe(0);
		expect(readStarts(world)).toHaveLength(0);
		expect(existsSync(world.bunLog)).toBe(false);
	});
});

describe("viewer location comes from the installed skill, never a legacy path", () => {
	test("the installed plugin viewer directory is where bun runs, found through DG_SKILLS_DIR alone", async () => {
		const viewer = installRealVizSkill(world);
		const run = await viz(
			["render", "--input", writePayload(world), "--no-open"],
			{
				VIZ_SKILL_DIR: undefined,
				DG_SKILLS_DIR: world.skills,
			},
		);
		expect(run.exitCode).toBe(0);
		const log = readFileSync(world.bunLog, "utf8");
		expect(log).toContain(`${realpathSync(viewer)}|install`);
		expect(log).toContain(`${realpathSync(viewer)}|run dev --port ${port}`);
		expect(log).not.toContain("/scripts/ai/skills");
	});

	test("a marketplace install is found from HOME alone", async () => {
		const marketplaceSkills = join(
			world.home,
			".claude/plugins/cache/detailedghost/dg/1.15.0/plugins/dg/skills",
		);
		const viewer = join(marketplaceSkills, "viz", "astro-viewer");
		mkdirSync(join(viewer, "node_modules"), { recursive: true });
		writeFileSync(join(viewer, "package.json"), "{}");
		const run = await viz(
			["render", "--input", writePayload(world), "--no-open"],
			{
				VIZ_SKILL_DIR: undefined,
			},
		);
		expect(run.exitCode).toBe(0);
		expect(readFileSync(world.bunLog, "utf8")).toContain(
			`${realpathSync(viewer)}|run dev`,
		);
	});

	test("with no installed viewer the command exits 1 naming DG_SKILLS_DIR and never a virtual path", async () => {
		const run = await viz(
			["render", "--input", writePayload(world), "--no-open"],
			{
				VIZ_SKILL_DIR: undefined,
			},
		);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("DG_SKILLS_DIR");
		expect(run.stderr).not.toContain("$bunfs");
		expect(readStarts(world)).toHaveLength(0);
	});
});

describe("cold install and external Bun prerequisite", () => {
	test("a failed first-run install exits 1 with the install failure and starts nothing", async () => {
		installFakeViewer(world, false);
		const run = await viz(
			["render", "--input", writePayload(world), "--no-open"],
			{
				PATH: world.failingBin,
			},
		);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("bun install failed");
		expect(run.stderr).toContain("fake registry unreachable");
		expect(readStarts(world)).toHaveLength(0);
	});

	test("the first run installs dependencies once and later runs skip the install", async () => {
		installFakeViewer(world, false);
		const payload = writePayload(world);
		expect(
			(await viz(["render", "--input", payload, "--no-open"])).exitCode,
		).toBe(0);
		expect(
			(await viz(["render", "--input", payload, "--no-open"])).exitCode,
		).toBe(0);
		expect(installLines(world.bunLog)).toHaveLength(1);
	});

	test("the install enforces the vendored lockfile", async () => {
		installFakeViewer(world, false);
		const run = await viz(["render", "--input", writePayload(world), "--no-open"]);
		expect(run.exitCode).toBe(0);
		const [line] = installLines(world.bunLog);
		expect(line.split("|")[1].split(" ")).toContain("--frozen-lockfile");
	});

	test("a changed lockfile reinstalls even though the marker exists", async () => {
		const viewer = installFakeViewer(world, true);
		const args = ["render", "--input", writePayload(world), "--no-open"];
		expect((await viz(args)).exitCode).toBe(0);
		expect(existsSync(world.bunLog)).toBe(true);
		expect(installLines(world.bunLog)).toHaveLength(0);
		writeFileSync(join(viewer, "bun.lock"), "changed");
		expect((await viz(args)).exitCode).toBe(0);
		expect(installLines(world.bunLog)).toHaveLength(1);
	});

	test("a read-only viewer directory exits 1 naming the directory and VIZ_SKILL_DIR", async () => {
		const viewer = installFakeViewer(world, false);
		chmodSync(viewer, 0o555);
		try {
			const run = await viz([
				"render",
				"--input",
				writePayload(world),
				"--no-open",
			]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain(viewer);
			expect(run.stderr).toContain("VIZ_SKILL_DIR");
			expect(run.stderr).toContain("writable");
		} finally {
			chmodSync(viewer, 0o755);
		}
	});

	test("an interrupted install leaves a partial tree and the next run installs again", async () => {
		installFakeViewer(world, false);
		const args = ["render", "--input", writePayload(world), "--no-open"];
		const first = await viz(args, { PATH: world.flakyBin });
		expect(first.exitCode).toBe(1);
		const second = await viz(args, { PATH: world.flakyBin });
		expect(second.exitCode).toBe(0);
		expect(installLines(world.bunLog)).toHaveLength(2);
	});

	test("two concurrent cold renders run exactly one install", async () => {
		installFakeViewer(world, false);
		const args = ["render", "--input", writePayload(world), "--no-open"];
		const runs = await Promise.all([viz(args), viz(args)]);
		expect(runs.map((r) => r.exitCode)).toEqual([0, 0]);
		expect(installLines(world.bunLog)).toHaveLength(1);
	});

	test("cold renders with different VIZ_DIR and VIZ_PORT run exactly one install", async () => {
		installFakeViewer(world, false);
		const args = ["render", "--input", writePayload(world), "--no-open"];
		const otherDir = join(world.base, "second viz");
		const otherPort = String(freePort());
		const runs = await Promise.all([
			viz(args),
			viz(args, { VIZ_PORT: otherPort, VIZ_DIR: otherDir }),
		]);
		expect(runs.map((r) => r.exitCode)).toEqual([0, 0]);
		expect(installLines(world.bunLog)).toHaveLength(1);
		await viz(["stop"], { VIZ_PORT: otherPort, VIZ_DIR: otherDir });
	});

	test.each([
		["cold", false],
		["warm", true],
	])(
		"with no bun on PATH a %s start exits 1 with an actionable prerequisite message",
		async (_name, withModules) => {
			installFakeViewer(world, withModules);
			const run = await viz(
				["render", "--input", writePayload(world), "--no-open"],
				{
					PATH: world.emptyBin,
				},
			);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toMatch(/Bun/);
			expect(run.stderr).toContain("https://bun.sh");
			expect(run.stderr).not.toMatch(/ENOENT|at .*\.ts:\d+/);
		},
	);
});

describe("server startup races and identity", () => {
	test("concurrent renders start exactly one viewer and all succeed", async () => {
		installFakeViewer(world, true);
		const payload = writePayload(world);
		const runs = await Promise.all(
			Array.from({ length: 4 }, () =>
				viz(["render", "--input", payload, "--no-open"]),
			),
		);
		for (const run of runs) expect(run.exitCode).toBe(0);
		expect(readStarts(world)).toHaveLength(1);
	}, 60_000);

	test("a foreign server serving a different VIZ_DIR is refused and nothing is started", async () => {
		installFakeViewer(world, true);
		const foreign = Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: (req) =>
				new URL(req.url).pathname === "/api/_meta"
					? Response.json({
							vizDir: join(world.base, "someone else"),
							port,
							pid: process.pid,
						})
					: new Response("ok"),
		});
		try {
			const run = await viz([
				"render",
				"--input",
				writePayload(world),
				"--no-open",
			]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain("different VIZ_DIR");
			expect(run.stderr).toContain("VIZ_PORT");
			expect(readStarts(world)).toHaveLength(0);
		} finally {
			foreign.stop(true);
		}
	});

	test("a server already serving the same VIZ_DIR is reused without a spawn", async () => {
		installFakeViewer(world, true);
		const same = Bun.serve({
			port,
			hostname: "127.0.0.1",
			fetch: (req) =>
				new URL(req.url).pathname === "/api/_meta"
					? Response.json({
							vizDir: `${world.vizDir}/`,
							port,
							pid: process.pid,
						})
					: new Response("ok"),
		});
		try {
			const run = await viz([
				"render",
				"--input",
				writePayload(world),
				"--no-open",
			]);
			expect(run.exitCode).toBe(0);
			expect(readStarts(world)).toHaveLength(0);
		} finally {
			same.stop(true);
		}
	});

	test("two VIZ_PORT values run isolated viewers side by side", async () => {
		installFakeViewer(world, true);
		const otherPort = freePort();
		const payload = writePayload(world);
		const a = await viz(["render", "--input", payload, "--no-open"]);
		const b = await viz(["render", "--input", payload, "--no-open"], {
			VIZ_PORT: String(otherPort),
			VIZ_DIR: join(world.base, "second viz"),
		});
		expect(a.exitCode).toBe(0);
		expect(b.exitCode).toBe(0);
		expect(b.stdout).toContain(`http://localhost:${otherPort}/viz/`);
		expect(readStarts(world)).toHaveLength(2);
		await viz(["stop"], {
			VIZ_PORT: String(otherPort),
			VIZ_DIR: join(world.base, "second viz"),
		});
	});
});

describe("dg-skills viz stop", () => {
	test("stops the viewer it started and frees the port", async () => {
		installFakeViewer(world, true);
		await viz(["render", "--input", writePayload(world), "--no-open"]);
		const [pid] = readStarts(world);
		const stop = await viz(["stop"]);
		expect(stop.exitCode).toBe(0);
		await Bun.sleep(500);
		const reachable = await fetch(`http://127.0.0.1:${port}/`, {
			signal: AbortSignal.timeout(1000),
		})
			.then(() => true)
			.catch(() => false);
		expect(reachable).toBe(false);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	test("with nothing running it exits 1 naming the port", async () => {
		installFakeViewer(world, true);
		const stop = await viz(["stop"]);
		expect(stop.exitCode).toBe(1);
		expect(stop.stderr).toContain(String(port));
	});
});

describe("dg-skills viz wait", () => {
	function seed(extra: Record<string, unknown>): string {
		const path = sessionPayloadPath(world);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				slug: `demo-${SESSION_ID}`,
				template: "plan",
				...extra,
			}),
		);
		return `demo-${SESSION_ID}`;
	}

	test("returns 0 once the payload reports all_clear", async () => {
		const slug = seed({ all_clear: true });
		const run = await viz(["wait", slug, "--timeout", "5"]);
		expect(run.exitCode).toBe(0);
	});

	test("wait --merge returns 0 when the payload already reports all_clear", async () => {
		const slug = seed({ all_clear: true });
		const run = await viz(["wait", slug, "--merge", "--timeout", "5"]);
		expect(run.exitCode).toBe(0);
	});

	test("the resume command printed on timeout is accepted once all_clear is set", async () => {
		const slug = seed({ all_clear: true });
		const run = await viz(["wait", slug, "--resume", "--timeout", "5"]);
		expect(run.exitCode).toBe(0);
	});

	test("review-wait behaves as wait", async () => {
		const slug = seed({ all_clear: true });
		const run = await viz(["review-wait", slug, "--timeout", "5"]);
		expect(run.exitCode).toBe(0);
	});

	test("a pending next-steps feedback round is reported on stdout and not as all_clear", async () => {
		const slug = seed({
			next_steps_feedback_pending: true,
			next_steps_feedback: [{ text: "x" }],
		});
		const run = await viz(["wait", slug, "--timeout", "5"]);
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({
			all_clear: false,
			next_steps_feedback_pending: true,
		});
	});

	test("a missing session fails with 1 and says to render first", async () => {
		const run = await viz(["wait", "never-rendered-1"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("render it first");
	});

	test("a non-positive timeout is rejected", async () => {
		const slug = seed({});
		const run = await viz(["wait", slug, "--timeout", "0"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("invalid --timeout");
	});

	test("a timeout exits 1 and prints an installed-binary resume command, never the legacy script path", async () => {
		const slug = seed({});
		const run = await viz(["wait", slug, "--timeout", "1"]);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain(`timed out after 1s`);
		expect(run.stderr).toContain(
			`resume with: ${shellCommand([binary, "viz", "wait", slug, "--resume"])}`,
		);
		expect(run.stderr).not.toContain("viz-cli");
		expect(run.stderr).not.toContain("/scripts/bin");
		expect(run.stderr).not.toMatch(/\/home\/detailedghost/);
	}, 30_000);
});

describe("dg-skills viz review", () => {
	test("emitted usage and errors name dg-skills viz, not the legacy viz-cli", async () => {
		const run = await viz(["review"]);
		expect(run.exitCode).toBe(1);
		expect(`${run.stdout}${run.stderr}`).not.toContain("viz-cli");
	});
});

describe.skipIf(process.env.DG_VIZ_REAL_VIEWER !== "1")(
	"real vendored viewer from a relocated skill dir",
	() => {
		test("installs dependencies, starts Astro and serves the board and meta", async () => {
			installRealVizSkill(world);
			const realBin = dirname(process.execPath);
			const realEnv = { PATH: `${realBin}:/usr/bin:/bin` };
			const run = await viz(
				["render", "--input", writePayload(world), "--no-open"],
				realEnv,
			);
			expect(run.exitCode).toBe(0);
			const slug = `demo-${SESSION_ID}`;
			const page = await fetch(`http://127.0.0.1:${port}/viz/${slug}`);
			expect(page.status).toBe(200);
			const meta = await fetch(`http://127.0.0.1:${port}/api/_meta`);
			expect(await meta.json()).toMatchObject({ port });
		}, 300_000);
	},
);
