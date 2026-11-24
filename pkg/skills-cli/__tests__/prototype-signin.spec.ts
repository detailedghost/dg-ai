import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acceptanceHook, refingerprint } from "../src/prototype/accepted";
import { sentinelPaths } from "../src/prototype/paths";
import { confirm } from "../src/prototype/sentinels";
import { readSignIn, writeSignIn } from "../src/prototype/signin";
import type { Capturer, CaptureRequest } from "../src/verify/capture-model";
import { verifyBrowserAvailable } from "../src/verify/playwright-capturer";
import { makeTempDir } from "./git-repo-fixtures";
import { collectRun, type SpecRun } from "./spec-fixtures";

const ENTRY = join(import.meta.dir, "../src/index.ts");
const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");
const browser = process.env.PW_E2E === "1" && verifyBrowserAvailable();
const ROOT = '[data-verify-root="demo"]';
const SESSION = "dummy-session=dummy-value";

let root: string;
let project: string;
let app: ReturnType<typeof Bun.serve> | undefined;
const children: Array<{ kill(): void }> = [];

setDefaultTimeout(60_000);

beforeEach(() => {
	root = makeTempDir("dg-prototype-signin-");
	project = join(root, "project");
	mkdirSync(join(root, "scratch"), { recursive: true });
	mkdirSync(project, { recursive: true });
});

afterEach(() => {
	app?.stop(true);
	app = undefined;
	for (const child of children.splice(0)) child.kill();
	rmSync(root, { recursive: true, force: true });
});

function cli(args: string[], extra: Record<string, string> = {}) {
	const proc = Bun.spawn([process.execPath, ENTRY, "prototype", ...args], {
		cwd: project,
		env: {
			...(process.env as Record<string, string>),
			AI_SCRATCH_DIR: join(root, "scratch"),
			DG_SKILLS_DIR: SKILLS,
			PROTOTYPE_UI_NO_OPEN: "1",
			DG_VERIFY_BROWSER: "/nonexistent",
			...extra,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	children.push(proc);
	return collectRun(proc) as Promise<SpecRun>;
}

const sandbox = (name = "demo") => join(project, ".agents", "prototype", name);

function startApp(): string {
	app = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
			if (url.pathname === "/prototype-signin")
				return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": `${SESSION}; Path=/; HttpOnly` } });
			if (url.pathname === "/Login/SignIn") return html("<!doctype html><html lang=\"en\"><body><p>Sign in</p></body></html>");
			if (!(req.headers.get("cookie") ?? "").includes(SESSION))
				return new Response(null, { status: 302, headers: { Location: `/Login/SignIn?ReturnUrl=${encodeURIComponent(url.pathname)}` } });
			return html(
				'<!doctype html><html lang="en"><head><title>Schedule</title></head><body><main data-verify-root="demo"><button type="button">Create shift</button></main></body></html>',
			);
		},
	});
	return `http://127.0.0.1:${app.port}`;
}

function httpCapturer(seen: CaptureRequest[]): () => Promise<Capturer> {
	return async () => ({
		async shot(request) {
			seen.push(request);
			let cookie = "";
			if (request.signIn) {
				const signedIn = await fetch(request.signIn, { redirect: "manual" });
				cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
			}
			const page = await fetch(request.url, { redirect: "manual", headers: cookie ? { cookie } : {} });
			const location = page.headers.get("location");
			const finalUrl = location ? new URL(location, request.url).toString() : request.url;
			const body = location ? "" : await page.text();
			return {
				png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
				html: body,
				finalUrl,
				menuFound: false,
				scrolled: false,
				engine: "playwright",
				fingerprint: body.includes("data-verify-root")
					? { root: { x: 0, y: 0, w: request.width, h: 100 }, controls: [], themeApplied: request.theme }
					: { error: `root: found 0 visible ${ROOT}` },
			};
		},
		async close() {},
	});
}

describe("stored sign-in", () => {
	test("writes only the sign-in url and state name, mode 0600, and reads them back", () => {
		const dir = sandbox();
		writeSignIn(dir, { signIn: "http://127.0.0.1:18416/prototype-signin?returnUrl=%2F" });
		const path = join(dir, ".signin");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			signIn: "http://127.0.0.1:18416/prototype-signin?returnUrl=%2F",
		});
		writeSignIn(dir, { stateName: "velora" });
		expect(readSignIn(dir)).toEqual({
			signIn: "http://127.0.0.1:18416/prototype-signin?returnUrl=%2F",
			stateName: "velora",
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("refuses a sign-in url off loopback and stores nothing", () => {
		const dir = sandbox();
		expect(() => writeSignIn(dir, { signIn: "https://login.example.com/" })).toThrow(/loopback/);
		expect(existsSync(join(dir, ".signin"))).toBe(false);
	});

	test("ignores a stored file that holds anything but a loopback url and a state name", () => {
		const dir = sandbox();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, ".signin"), JSON.stringify({ signIn: "https://login.example.com/", cookie: "x=y" }));
		expect(readSignIn(dir)).toEqual({});
		writeFileSync(join(dir, ".signin"), "not json");
		expect(readSignIn(dir)).toEqual({});
	});

	test("the claim reads the layout signed in when only the sandbox holds the sign-in", async () => {
		const origin = startApp();
		const dir = sandbox();
		writeSignIn(dir, { signIn: `${origin}/prototype-signin` });
		const seen: CaptureRequest[] = [];
		const hook = acceptanceHook({ dir, name: "demo", chain: "demo" }, { open: httpCapturer(seen) });
		const skipped = await hook({ variant: "D", notes: "", source: "browser", url: `${origin}/ScheduleDoctor/ViewSchedule?variant=D` });
		expect(skipped).toBeUndefined();
		expect(seen).toHaveLength(6);
		expect(seen.every((request) => request.signIn === `${origin}/prototype-signin`)).toBe(true);
		const record = JSON.parse(readFileSync(join(dir, "accepted.json"), "utf8")) as { fingerprint: { readings: unknown[] } | null; skipped: string | null };
		expect(record.skipped).toBeNull();
		expect(record.fingerprint?.readings).toHaveLength(6);
		expect(readFileSync(join(dir, "accepted.json"), "utf8")).not.toContain("prototype-signin");
	});

	test("without a stored sign-in the same claim lands on the sign-in page and says so", async () => {
		const origin = startApp();
		const dir = sandbox();
		const hook = acceptanceHook({ dir, name: "demo", chain: "demo" }, { open: httpCapturer([]) });
		const skipped = await hook({ variant: "D", notes: "", source: "browser", url: `${origin}/ScheduleDoctor/ViewSchedule?variant=D` });
		expect(skipped).toContain("the page redirected to /Login/SignIn");
	});

	test("an explicit sign-in on the target wins over the stored one", async () => {
		const origin = startApp();
		const dir = sandbox();
		writeSignIn(dir, { signIn: `${origin}/stale-signin`, stateName: "velora" });
		const seen: CaptureRequest[] = [];
		const hook = acceptanceHook(
			{ dir, name: "demo", chain: "demo", signIn: `${origin}/prototype-signin` },
			{ open: httpCapturer(seen) },
		);
		await hook({ variant: "D", notes: "", source: "browser", url: `${origin}/ScheduleDoctor/ViewSchedule` });
		expect(seen.every((request) => request.signIn === `${origin}/prototype-signin`)).toBe(true);
		expect(seen.every((request) => request.stateName === "velora")).toBe(true);
	});

	test("fingerprint uses the stored sign-in too", async () => {
		const origin = startApp();
		const dir = sandbox();
		const hook = acceptanceHook({ dir, name: "demo", chain: "demo" }, { open: httpCapturer([]) });
		await hook({ variant: "D", notes: "", source: "browser", url: `${origin}/ScheduleDoctor/ViewSchedule` });
		writeSignIn(dir, { signIn: `${origin}/prototype-signin` });
		const record = await refingerprint(dir, "demo", `${origin}/ScheduleDoctor/ViewSchedule`, { open: httpCapturer([]) });
		expect(record.skipped).toBeNull();
	});
});

describe("prototype sign-in on the command line", () => {
	test("sign-in records the url in the sandbox, and a later plain wait claims with it", async () => {
		const recorded = await cli(["sign-in", "demo", "--sign-in=http://127.0.0.1:18416/prototype-signin"]);
		expect(recorded.exitCode).toBe(0);
		expect(statSync(join(sandbox(), ".signin")).mode & 0o777).toBe(0o600);
		confirm(sentinelPaths(sandbox()), "D", "", "browser");
		writeFileSync(join(sandbox(), ".url"), "http://127.0.0.1:18416/ScheduleDoctor/ViewSchedule\n");
		const claimed = await cli(["wait", "demo", "--timeout=1"]);
		expect(claimed.exitCode).toBe(75);
		expect(claimed.stderr).toContain("--sign-in=<loopback-url>");
		expect(claimed.stderr).toContain("browser unavailable");
	});

	test("without a stored sign-in the same plain wait names no sign-in in its repair hint", async () => {
		confirm(sentinelPaths(sandbox()), "D", "", "browser");
		writeFileSync(join(sandbox(), ".url"), "http://127.0.0.1:18416/ScheduleDoctor/ViewSchedule\n");
		const claimed = await cli(["wait", "demo", "--timeout=1"]);
		expect(claimed.stderr).toContain("browser unavailable");
		expect(claimed.stderr).not.toContain("--sign-in=<loopback-url>");
	});

	test("sign-in refuses a url off loopback", async () => {
		const result = await cli(["sign-in", "demo", "--sign-in=https://login.example.com/"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("loopback");
		expect(existsSync(join(sandbox(), ".signin"))).toBe(false);
	});

	test("sign-in with no --sign-in or --state is a usage error", async () => {
		const result = await cli(["sign-in", "demo"]);
		expect(result.exitCode).toBe(1);
	});

	test("wait --sign-in stores the url for the next claim", async () => {
		await cli(["wait", "demo", "--timeout=0", "--sign-in=http://127.0.0.1:18416/prototype-signin"]);
		expect(readSignIn(sandbox())).toEqual({ signIn: "http://127.0.0.1:18416/prototype-signin" });
	});

	test.skipIf(!browser)("a real browser claim behind a login reads the layout from the stored sign-in", async () => {
		const origin = startApp();
		expect((await cli(["sign-in", "demo", `--sign-in=${origin}/prototype-signin`])).exitCode).toBe(0);
		confirm(sentinelPaths(sandbox()), "D", "", "browser");
		writeFileSync(join(sandbox(), ".url"), `${origin}/ScheduleDoctor/ViewSchedule?variant=D\n`);
		const env = { DG_VERIFY_BROWSER: process.env.DG_VERIFY_BROWSER ?? "" };
		const claimed = await cli(["wait", "demo", "--timeout=1"], env);
		expect(claimed.exitCode).toBe(0);
		const record = JSON.parse(readFileSync(join(sandbox(), "accepted.json"), "utf8")) as { skipped: string | null; fingerprint: { readings: unknown[] } | null };
		expect(record.skipped).toBeNull();
		expect(record.fingerprint?.readings).toHaveLength(6);
	});
});
