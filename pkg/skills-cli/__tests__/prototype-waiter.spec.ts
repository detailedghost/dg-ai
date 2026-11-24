import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sentinelPaths } from "../src/prototype/paths";
import { confirm, liveWaiter, wait } from "../src/prototype/sentinels";
import { injectIntoHtml, startServer, type RunningServer } from "../src/prototype/serve";
import { makeTempDir } from "./git-repo-fixtures";
import { collectRun, type SpecRun } from "./spec-fixtures";

const ENTRY = join(import.meta.dir, "../src/index.ts");
const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");
const DEAD_PID = 2 ** 22 + 7;

let root: string;
let project: string;
let server: RunningServer | undefined;
const children: Array<{ kill(): void }> = [];

setDefaultTimeout(30_000);

beforeEach(() => {
	root = makeTempDir("dg-prototype-waiter-");
	project = join(root, "project");
	mkdirSync(join(root, "scratch"), { recursive: true });
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	server?.stop();
	server = undefined;
	for (const child of children.splice(0)) child.kill();
	rmSync(root, { recursive: true, force: true });
});

function cli(args: string[]) {
	const proc = Bun.spawn([process.execPath, ENTRY, "prototype", ...args], {
		cwd: project,
		env: {
			...(process.env as Record<string, string>),
			AI_SCRATCH_DIR: join(root, "scratch"),
			DG_SKILLS_DIR: SKILLS,
			PROTOTYPE_UI_NO_OPEN: "1",
			DG_VERIFY_BROWSER: "/nonexistent",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(proc);
	return { pid: proc.pid, done: collectRun(proc) as Promise<SpecRun> };
}

const sandbox = (name = "demo") => sentinelPaths(join(project, ".agents", "prototype", name));

async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await Bun.sleep(50);
	}
	throw new Error("condition never held");
}

describe("prototype waiter", () => {
	test("wait records its own pid as the live waiter and removes it after the claim", async () => {
		const paths = sandbox();
		const waiting = wait(paths, 5);
		expect(liveWaiter(paths)).toBe(process.pid);
		confirm(paths, "B");
		expect(await waiting).toEqual({ status: "ok", variant: "B", notes: "" });
		expect(existsSync(paths.waiter)).toBe(false);
		expect(liveWaiter(paths)).toBeUndefined();
	});

	test("a timed out wait removes its waiter file too", async () => {
		const paths = sandbox();
		expect(await wait(paths, 0)).toEqual({ status: "timeout" });
		expect(existsSync(paths.waiter)).toBe(false);
	});

	test("a waiter file whose pid is dead does not count as a live waiter", () => {
		const paths = sandbox();
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.waiter, `${DEAD_PID}\n`);
		expect(liveWaiter(paths)).toBeUndefined();
		writeFileSync(paths.waiter, "not a pid\n");
		expect(liveWaiter(paths)).toBeUndefined();
	});

	test("a finished wait leaves the file alone when another waiter took it over", async () => {
		const paths = sandbox();
		const waiting = wait(paths, 5);
		writeFileSync(paths.waiter, `${process.ppid}\n`);
		confirm(paths, "A");
		await waiting;
		expect(readFileSync(paths.waiter, "utf8").trim()).toBe(String(process.ppid));
	});

	test("a background wait process is reported by status --json, and gone after it claims", async () => {
		const waiter = cli(["wait", "demo", "--timeout=20", "--json"]);
		await until(() => existsSync(sandbox().waiter));
		const live = await cli(["status", "demo", "--json", "--require-waiter"]).done;
		expect(live.exitCode).toBe(0);
		expect(JSON.parse(live.stdout).waiter).toEqual({ pid: waiter.pid });
		confirm(sandbox(), "C");
		const claimed = await waiter.done;
		expect(JSON.parse(claimed.stdout)).toEqual({ status: "ok", variant: "C", notes: "" });
		expect(existsSync(sandbox().waiter)).toBe(false);
	});

	test("status with no waiter says waiter: none with the exact wait command, and --require-waiter fails", async () => {
		const plain = await cli(["status", "demo"]).done;
		expect(plain.exitCode).toBe(0);
		expect(plain.stdout).toBe("pending\n");
		expect(plain.stderr).toContain("waiter: none; run: dg prototype wait demo --json");
		const json = await cli(["status", "demo", "--json"]).done;
		expect(JSON.parse(json.stdout).waiter).toBeNull();
		const required = await cli(["status", "demo", "--require-waiter"]).done;
		expect(required.exitCode).toBe(1);
		expect(required.stderr).toContain("waiter: none; run: dg prototype wait demo --json");
		const light = await cli(["status", "demo", "--light", "--require-waiter"]).done;
		expect(light.stderr).toContain("run: dg prototype wait demo --light --json");
	});

	test("serve prints waiter: none with the wait command in its banner", async () => {
		const html = join(root, "page.html");
		writeFileSync(html, "<html><head></head><body></body></html>");
		const proc = Bun.spawn(
			[process.execPath, ENTRY, "prototype", "serve", html, "demo", `--port=${46000 + Math.floor(Math.random() * 1000)}`],
			{
				cwd: project,
				env: { ...(process.env as Record<string, string>), AI_SCRATCH_DIR: join(root, "scratch"), DG_SKILLS_DIR: SKILLS },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		children.push(proc);
		const reader = proc.stdout.getReader();
		let banner = "";
		while (!banner.includes("Ctrl-C")) {
			const { value, done } = await reader.read();
			if (done) break;
			banner += new TextDecoder().decode(value);
		}
		reader.releaseLock();
		expect(banner.split("\n")[0]).toMatch(/^prototype-serve: http:\/\/127\.0\.0\.1:\d+\/$/);
		expect(banner).toContain("waiter: none; run: dg prototype wait demo --json");
	});
});

describe("decision page with and without a waiter", () => {
	async function served() {
		const htmlFile = join(root, "page.html");
		writeFileSync(htmlFile, "<html><head></head><body></body></html>");
		const paths = sentinelPaths(join(root, "sentinels"));
		server = await startServer({ htmlFile, name: "demo", paths, port: 47000 + Math.floor(Math.random() * 1000), tools: [] });
		const url = `http://127.0.0.1:${server.port}`;
		const post = (body: Record<string, unknown>) =>
			fetch(`${url}/prototype-decision`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
				body: JSON.stringify({ action: "confirm", variant: "A", ...body }),
			}).then((response) => response.json() as Promise<Record<string, unknown>>);
		return { url, paths, post };
	}

	test("a pick with no live waiter answers waiter: false, and the state route says the same", async () => {
		const { url, post } = await served();
		expect(await post({})).toEqual({ ok: true, waiter: false });
		const state = (await (await fetch(`${url}/prototype-state`)).json()) as Record<string, unknown>;
		expect(state.waiter).toBe(false);
	});

	test("a pick with a live waiter answers waiter: true", async () => {
		const { paths, post } = await served();
		mkdirSync(paths.dir, { recursive: true });
		writeFileSync(paths.waiter, `${process.pid}\n`);
		expect(await post({ action: "reject", notes: "no" })).toEqual({ ok: true, waiter: true });
	});

	test("the injected client tells the user no agent is listening and keeps the tab open", () => {
		const page = injectIntoHtml("<html><head></head><body></body></html>", "demo", []);
		expect(page).toContain("No agent is listening; tell your agent to check.");
		expect(page).toContain("d.waiter === false");
	});
});
