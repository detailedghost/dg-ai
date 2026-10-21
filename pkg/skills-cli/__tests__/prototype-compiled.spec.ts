import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mergeEnv } from "./module-call";
import {
	collectRun,
	disposeSpecContext,
	newSpecContext,
	SOURCE_SKILLS,
	type SpecContext,
	type SpecRun,
} from "./spec-fixtures";

setDefaultTimeout(60_000);

let context: SpecContext;
let binary: string;
let skills: string;
let opener: string;
let outside: string;
let project: string;
let downloads: string;
const spawned: Array<{ kill(): void }> = [];

function env(extra: Record<string, string | undefined> = {}) {
	return mergeEnv({
		HOME: context.home,
		AI_SCRATCH_DIR: context.scratch,
		AI_STATE_DIR: context.state,
		PATH: opener,
		TZ: "UTC",
		LC_ALL: "C",
		DG_SKILLS_DIR: skills,
		DG_SKILLS_DEST: undefined,
		DG_HOME: join(context.base, "dg-home"),
		SCRIPTS_ROOT: undefined,
		CLAUDE_PLUGIN_ROOT: undefined,
		CODEX_PLUGIN_ROOT: undefined,
		DG_PLUGIN_ROOT: undefined,
		WSL_DISTRO_NAME: "",
		PROTOTYPE_UI_NO_OPEN: "1",
		DG_TEST_DOWNLOADS: downloads,
		...extra,
	});
}

function launch(
	args: string[],
	cwd = outside,
	extra: Record<string, string | undefined> = {},
) {
	const proc = Bun.spawn([binary, ...args], {
		cwd,
		env: env(extra),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	spawned.push(proc);
	return proc;
}

function start(
	args: string[],
	cwd = outside,
	extra: Record<string, string | undefined> = {},
) {
	const proc = launch(args, cwd, extra);
	return { proc, done: collectRun(proc) as Promise<SpecRun> };
}

const compiled = (
	args: string[],
	cwd = outside,
	extra: Record<string, string | undefined> = {},
) => start(args, cwd, extra).done;

function executable(path: string, source: string): void {
	writeFileSync(path, source);
	chmodSync(path, 0o755);
}

beforeAll(() => {
	context = newSpecContext();
	binary = join(context.base, "moved ' install", "dg-skills");
	mkdirSync(join(binary, ".."), { recursive: true });
	const build = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../build.ts"),
			"--outfile",
			binary,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	skills = join(context.base, "relocated plugin", "skills");
	cpSync(join(SOURCE_SKILLS, "proto"), join(skills, "proto"), {
		recursive: true,
	});
	opener = join(context.base, "fake bin");
	outside = join(context.base, "outside folder");
	project = join(context.base, "target project");
	downloads = join(context.base, "downloads");
	for (const dir of [opener, outside, project, downloads])
		mkdirSync(dir, { recursive: true });
	const open = [
		"#!/bin/sh",
		'printf "%s" "$1" > "$DG_TEST_OPENED_URL"',
		'if [ -n "${DG_TEST_VERDICT:-}" ]; then',
		'  /bin/mkdir -p "$DG_TEST_VERDICT_DIR"',
		'  printf "%s" "$DG_TEST_VERDICT" > "$DG_TEST_VERDICT_PATH"',
		"fi",
		"exit 0",
		"",
	].join("\n");
	executable(join(opener, "xdg-open"), open);
	executable(join(opener, "wslview"), open);
	executable(
		join(opener, "cmd.exe"),
		'#!/bin/sh\nprintf "%s\\n" "C:\\\\Users\\\\Ada"\n',
	);
	executable(
		join(opener, "wslpath"),
		'#!/bin/sh\nprintf "%s\\n" "$DG_TEST_DOWNLOADS"\n',
	);
	executable(
		join(opener, "xdg-user-dir"),
		'#!/bin/sh\nprintf "%s\\n" "$DG_TEST_DOWNLOADS"\n',
	);
}, 240_000);

afterEach(() => {
	for (const child of spawned.splice(0)) child.kill();
});

afterAll(() => disposeSpecContext(context));

const port = () => 43000 + Math.floor(Math.random() * 2000);

async function session(chain: string): Promise<{ pid: number; port: number }> {
	const path = join(context.scratch, "prototype-ui", `${chain}.json`);
	for (let i = 0; i < 150; i++) {
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
		await Bun.sleep(100);
	}
	throw new Error(`no session for ${chain}`);
}

const post = (listening: number, body: unknown) =>
	fetch(`http://127.0.0.1:${listening}/prototype-decision`, {
		method: "POST",
		body: JSON.stringify(body),
	});

async function isDown(listening: number): Promise<boolean> {
	for (let i = 0; i < 50; i++) {
		try {
			await fetch(`http://127.0.0.1:${listening}/prototype-state`);
		} catch {
			return true;
		}
		await Bun.sleep(100);
	}
	return false;
}

describe("compiled dg-skills prototype, local mode, from an outside folder", () => {
	test("logic route: confirm, status, wait, reject, and the legacy timeout status", async () => {
		expect((await compiled(["prototype", "status", "logic"])).stdout).toBe(
			"pending\n",
		);
		expect(
			(
				await compiled([
					"prototype",
					"confirm",
					"logic",
					"B",
					"--notes=keep it",
				])
			).exitCode,
		).toBe(0);
		expect((await compiled(["prototype", "status", "logic"])).stdout).toBe(
			"B\n",
		);
		const claimed = await compiled(["prototype", "wait", "logic", "--json"]);
		expect(claimed.exitCode).toBe(0);
		expect(claimed.stdout).toBe(
			'{"status":"ok","variant":"B","notes":"keep it"}\n',
		);
		expect((await compiled(["prototype", "status", "logic"])).stdout).toBe(
			"pending\n",
		);

		const timed = await compiled([
			"prototype",
			"wait",
			"logic",
			"--timeout=1",
			"--json",
		]);
		expect(timed.exitCode).toBe(1);
		expect(timed.stdout).toBe('{"status":"timeout"}\n');

		const rejectPath = (await compiled(["prototype", "path", "logic"])).stdout
			.trim()
			.replace(/\.selection$/, ".reject");
		writeFileSync(rejectPath, "too busy\n");
		const rejected = await compiled(["prototype", "wait", "logic", "--json"]);
		expect(rejected.stdout).toBe('{"status":"rejected","notes":"too busy"}\n');
		expect(existsSync(rejectPath)).toBe(false);
	});

	test("UI route: self-dispatches the server, serves the page, and tears down on approve", async () => {
		const planPath = join(context.base, "plan.json");
		writeFileSync(
			planPath,
			JSON.stringify({
				slug: "compiled-ui",
				question: "Which layout?",
				mode: "replace",
				variations: [
					{
						key: "a",
						label: "Alpha",
						html: "<h1>Alpha</h1>",
						css: "h1 { color: red; }",
					},
					{ key: "b", label: "Beta", html: "<h1>Beta</h1>", css: "" },
				],
			}),
		);
		const run = start([
			"prototype",
			"ui",
			planPath,
			"--no-open",
			`--port=${port()}`,
			"--timeout=60",
		]);
		const live = await session("compiled-ui");
		const page = await (await fetch(`http://127.0.0.1:${live.port}/`)).text();
		expect(page).toContain('data-variant="b"');
		expect(page).toContain("window.prototypeDecide");
		expect(page).toContain('"get_prototype_state"');
		await post(live.port, { action: "confirm", variant: "b", notes: "" });
		const result = await run.done;
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			status: "ok",
			variant: "b",
			notes: "",
		});
		expect(await isDown(live.port)).toBe(true);
		expect(
			existsSync(join(context.scratch, "prototype-ui", "compiled-ui.json")),
		).toBe(false);
	});

	test("UI route: a decision stored for a session is claimed from a different cwd", async () => {
		const manifest = join(context.base, "pinned.md");
		writeFileSync(
			manifest,
			"---\nname: compiled-pinned\n---\n::: A\n<h1>A</h1>\n:::\n",
		);
		const run = start(
			[
				"prototype",
				"ui",
				manifest,
				"--no-open",
				`--port=${port()}`,
				"--timeout=60",
			],
			context.home,
		);
		const live = await session("compiled-pinned");
		run.proc.kill();
		await run.done;
		await post(live.port, { action: "confirm", variant: "A", notes: "go on" });
		const claimed = await compiled(
			["prototype", "wait", "compiled-pinned", "--timeout=5"],
			project,
		);
		expect(JSON.parse(claimed.stdout)).toEqual({
			status: "ok",
			variant: "A",
			notes: "go on",
		});
		const stopped = await compiled(["prototype", "stop", "compiled-pinned"]);
		expect(JSON.parse(stopped.stdout).found).toBe(true);
		expect(await isDown(live.port)).toBe(true);
	});

	test("walkthrough route: serve a page, post a plan decision, and await it with a changes manifest", async () => {
		const page = join(project, "walkthrough.html");
		writeFileSync(
			page,
			"<html><head></head><body><nav data-go='list'>List</nav></body></html>",
		);
		const served = launch(
			["prototype", "serve", page, "walk", `--port=${port()}`],
			project,
		);
		const reader = served.stdout.getReader();
		let output = "";
		while (!output.includes("Press Ctrl-C")) {
			const { value, done } = await reader.read();
			if (done) break;
			output += new TextDecoder().decode(value);
		}
		const listening = Number(/127\.0\.0\.1:(\d+)/.exec(output)?.[1]);
		expect(listening).toBeGreaterThan(0);

		const html = await (await fetch(`http://127.0.0.1:${listening}/`)).text();
		expect(html).toContain("prototypePlanDecision");
		await post(listening, { decision: "rework", notes: "reorder screens" });
		const decision = await compiled(
			["prototype", "await-decision", "walk", "--json"],
			project,
		);
		expect(decision.exitCode).toBe(0);
		expect(JSON.parse(decision.stdout)).toEqual({
			decision: "REWORK",
			notes: "reorder screens",
		});

		const changesPath = (
			await compiled(["prototype", "changes-path", "walk"], project)
		).stdout.trim();
		const reloadPath = (
			await compiled(["prototype", "reload-path", "walk"], project)
		).stdout.trim();
		writeFileSync(
			changesPath,
			'{"rev":"7","screens":[{"id":"list","note":"moved"}]}',
		);
		writeFileSync(reloadPath, "7\n");
		expect(
			await (
				await fetch(`http://127.0.0.1:${listening}/prototype-reload`)
			).json(),
		).toEqual({ token: "7" });
		expect(
			(
				(await (
					await fetch(`http://127.0.0.1:${listening}/prototype-changes`)
				).json()) as { rev: string }
			).rev,
		).toBe("7");

		served.kill();
		expect(await isDown(listening)).toBe(true);
	});

	test("components and webmcp return the real installed assets", async () => {
		const components = await compiled(["prototype", "components"]);
		expect(components.stdout.trim()).toBe(join(skills, "proto", "assets"));
		expect(
			existsSync(join(components.stdout.trim(), "PrototypeSwitcher.tsx")),
		).toBe(true);
		const webmcp = JSON.parse(
			(await compiled(["prototype", "webmcp"])).stdout,
		) as { tools: Array<{ name: string }> };
		expect(webmcp.tools.map((tool) => tool.name)).toEqual([
			"get_prototype_state",
			"list_prototype_variants",
		]);
	});

	test("a missing installed skill reports the asset instead of a virtual path", async () => {
		const result = await compiled(["prototype", "components"], outside, {
			DG_SKILLS_DIR: join(context.base, "empty skills"),
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Skill asset not found: proto/assets");
	});

	test("plain proto runs the local mode and an extension verb needs --ext", async () => {
		expect(
			(await compiled(["proto", "confirm", "viaproto", "A"])).exitCode,
		).toBe(0);
		expect((await compiled(["proto", "status", "viaproto"])).stdout).toBe(
			"A\n",
		);
		const plant = await compiled(["proto", "plant", "plan.json"]);
		expect(plant.exitCode).toBe(1);
		expect(plant.stderr).toContain("add --ext");
	});
});

describe("compiled dg-skills proto --ext, plan handoff through fakes", () => {
	test("plants the plan on the recorded page and exports the approved answer", async () => {
		const slug = "example-test-account-a1b2c3d4";
		const url = "https://example.test/account";
		const plan = {
			slug,
			question: "Which summary works best?",
			mode: "replace",
			variations: [
				{
					key: "compact",
					label: "Compact",
					html: "<p>Compact</p>",
					css: "p { padding: 1rem; }",
				},
				{
					key: "detailed",
					label: "Detailed",
					html: "<p>Detailed</p>",
					css: "p { padding: 2rem; }",
				},
			],
		};
		const planPath = join(context.base, "ext-plan.json");
		writeFileSync(planPath, JSON.stringify(plan));
		const styleGuidePath = join(
			context.scratch,
			"proto",
			slug,
			"style-guide.json",
		);
		mkdirSync(join(styleGuidePath, ".."), { recursive: true });
		writeFileSync(
			styleGuidePath,
			JSON.stringify({
				meta: { url, scrapedAt: 1_721_234_567_890, sameOrigin: true },
				tokens: {
					customProps: {},
					colors: ["rgb(0, 0, 0)"],
					fontStack: "sans-serif",
					typeScale: [],
					spacing: [],
					radii: [],
					shadows: [],
				},
				components: { button: {}, input: {}, link: {} },
			}),
		);
		const openedUrl = join(context.base, "opened-url.txt");
		const result = await compiled(
			["proto", "--ext", "plant", planPath, "--timeout", "5000"],
			project,
			{
				DG_TEST_OPENED_URL: openedUrl,
				DG_TEST_VERDICT_DIR: join(downloads, "dg-proto", slug),
				DG_TEST_VERDICT_PATH: join(downloads, "dg-proto", slug, "verdict.json"),
				DG_TEST_VERDICT: JSON.stringify({
					slug,
					ts: 1_721_234_568_000,
					action: "approve",
					selectedKey: "detailed",
				}),
			},
		);
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(
			join(project, ".agents", "prototype", slug, "index.html"),
		);
		expect(readFileSync(openedUrl, "utf8")).toContain(`${url}#`);
		expect(
			readFileSync(
				join(project, ".agents", "prototype", slug, "NOTES.md"),
				"utf8",
			),
		).toContain("- picked: detailed");
	});

	test("--ext needs the extension on a CLI-only install while local mode still works", async () => {
		mkdirSync(join(context.base, "dg-home"), { recursive: true });
		writeFileSync(join(context.base, "dg-home", "cli-only"), "");
		const ext = await compiled(["proto", "--ext", "cleanup", "some-slug"]);
		expect(ext.exitCode).toBe(1);
		expect(ext.stderr).toContain("needs the dg-ai-extension");
		expect(
			(await compiled(["proto", "confirm", "cliOnly", "A"])).exitCode,
		).toBe(0);
	});
});
