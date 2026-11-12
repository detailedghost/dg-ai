import { describe, expect, spyOn, test } from "bun:test";
import { type Launchers, openSession, type PlayerSession } from "../src/demo/player-process";
import { type BrowserPlan, type PlayerJob, SETUP_NEEDS_PERSON } from "../src/demo/player-job";
import { join } from "node:path";

const session = (_name: string): PlayerSession => ({
	open: async () => ({}) as never,
	close: async () => {},
});

const job = (plan?: BrowserPlan): PlayerJob => ({
	slug: "s",
	planPath: "/tmp/none",
	dir: "/tmp/none",
	startUrl: "https://example.test/",
	script: { title: "t", startUrl: "https://example.test/", steps: [] },
	...(plan ? { plan } : {}),
});

function launchers(windowsFails: boolean): Launchers & { used: string[] } {
	const used: string[] = [];
	return {
		used,
		pick: () => ({ channel: "chrome" }),
		local: async () => (used.push("local"), session("local")),
		windows: async () => {
			used.push("windows");
			if (windowsFails) throw new Error("recordVideo is not supported over CDP");
			return session("windows");
		},
	};
}

describe("openSession over the Windows plan", () => {
	const windows: BrowserPlan = { mode: "windows" };

	test("keeps the Windows session when it launches", async () => {
		const l = launchers(false);
		await openSession(job(windows), l);
		expect(l.used).toEqual(["windows"]);
	});

	test("falls back to a headless local Chromium and prints one line", async () => {
		const log = spyOn(console, "log").mockImplementation(() => undefined);
		const l = launchers(true);
		await openSession(job(windows), l);
		expect(l.used).toEqual(["windows", "local"]);
		expect(log).toHaveBeenCalledTimes(1);
		expect(String(log.mock.calls[0]?.[0])).toContain("headless local Chromium");
		log.mockRestore();
	});

	test("refuses the headless fallback when excluded setup needs a person to type a secret", async () => {
		const log = spyOn(console, "log").mockImplementation(() => undefined);
		const l = launchers(true);
		const base = job(windows);
		const withSetup: PlayerJob = {
			...base,
			script: {
				...base.script,
				setup: {
					includeInTour: false,
					steps: [
						{ title: "Sign in", body: "Log in.", selector: "#p", action: { do: "fill", value: "$DG_DEMO_UNSET_PW" } },
					],
				},
			},
		};
		const error = await openSession(withSetup, l).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(SETUP_NEEDS_PERSON);
		expect((error as { exitCode?: number }).exitCode).toBe(2);
		expect(l.used).toEqual(["windows"]);
		log.mockRestore();
	});

	test("keeps the headless fallback when setup is included in the tour", async () => {
		const log = spyOn(console, "log").mockImplementation(() => undefined);
		const l = launchers(true);
		const base = job(windows);
		await openSession(
			{
				...base,
				script: {
					...base.script,
					setup: { includeInTour: true, steps: [{ title: "Sign in", body: "Log in." }] },
				},
			},
			l,
		);
		expect(l.used).toEqual(["windows", "local"]);
		log.mockRestore();
	});

	test("keeps the headless fallback when excluded setup has every variable set", async () => {
		process.env.DG_DEMO_FALLBACK_PW = "x";
		const log = spyOn(console, "log").mockImplementation(() => undefined);
		const l = launchers(true);
		const base = job(windows);
		await openSession(
			{
				...base,
				script: {
					...base.script,
					setup: {
						includeInTour: false,
						steps: [
							{ title: "Sign in", body: "Log in.", selector: "#p", action: { do: "fill", value: "$DG_DEMO_FALLBACK_PW" } },
						],
					},
				},
			},
			l,
		);
		expect(l.used).toEqual(["windows", "local"]);
		log.mockRestore();
		delete process.env.DG_DEMO_FALLBACK_PW;
	});
});

describe("openSession cleanup when the CDP connection fails", () => {
	test("closes the Windows browser", async () => {
		const src = (file: string) => join(import.meta.dir, "..", "src", file);
		const code = `
import { mock } from "bun:test";
const closed = [];
const real = await import(${JSON.stringify(src("pw/core/windows.ts"))});
mock.module(${JSON.stringify(src("pw/core/windows.ts"))}, () => ({
  ...real,
  windowsProfileDir: async () => "/p",
  startWindowsBrowser: async () => ({ cdpUrl: "http://127.0.0.1:1" }),
  closeWindowsBrowser: async (profile) => { closed.push(profile); return { forced: 0, remaining: 0 }; },
}));
mock.module("playwright-core", () => ({
  chromium: { connectOverCDP: async () => { throw new Error("ws refused"); } },
}));
const { openSession } = await import(${JSON.stringify(src("demo/player-process.ts"))});
let error = "";
try {
  await openSession({ slug: "s", planPath: "/tmp/none", dir: "/tmp/none", startUrl: "https://example.test/", script: { title: "t", startUrl: "https://example.test/", steps: [] }, plan: { mode: "windows" } });
} catch (e) { error = e.message; }
console.log(JSON.stringify({ error, closed }));
`;
		const child = Bun.spawn([process.execPath, "-e", code], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [out, err] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const line = out.trim().split("\n").at(-1) ?? "";
		expect(() => JSON.parse(line), `${out}\n${err}`).not.toThrow();
		expect(JSON.parse(line).closed).toEqual(["/p"]);
	});
});
