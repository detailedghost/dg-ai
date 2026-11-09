import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TourScript } from "@dg/common";
import { verifyLocal, type VerifyLocalDeps } from "../src/demo/verify-local";
import { findInstalledChromium } from "../src/utils/find-browser";
import { fakeBrowser } from "./demo-run-fakes";

setDefaultTimeout(90_000);

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dg-verify-local-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const script = (): TourScript => ({
	title: "t",
	startUrl: "https://example.test/",
	steps: [
		{ title: "One", body: "a", selector: "#one" },
		{ title: "Two", body: "b", selector: "#two" },
	],
});

function opening(options: Parameters<typeof fakeBrowser>[0], env: VerifyLocalDeps["env"] = {}) {
	const browser = fakeBrowser(options);
	const closed: string[] = [];
	const deps: VerifyLocalDeps = {
		env,
		open: async () => {
			const context = await browser.session.open(false);
			return {
				page: await context.newPage(),
				close: async () => void closed.push("closed"),
			};
		},
	};
	return { browser, deps, closed };
}

describe("verifyLocal", () => {
	test("reports ok for a plan whose selectors all resolve", async () => {
		const { deps, closed } = opening({ dir });
		expect(await verifyLocal(script(), deps)).toEqual({ ok: true, findings: [] });
		expect(closed).toEqual(["closed"]);
	});

	test("names the step and selector that did not resolve", async () => {
		const { deps } = opening({ dir, missing: ["#two"] });
		const result = await verifyLocal(script(), deps);
		expect(result).toEqual({
			ok: false,
			findings: [{ step: 2, kind: "selector-unresolved", selector: "#two" }],
		});
	});

	test("names the variable, never its value, when a fill needs an unset env variable", async () => {
		const fill = (value: string): TourScript => ({
			...script(),
			steps: [
				{ title: "User", body: "a", selector: "#one", action: { do: "fill", value: "dante" } },
				{ title: "Password", body: "b", selector: "#two", action: { do: "fill", value } },
			],
		});
		const unset = opening({ dir }, { OTHER: "hunter2" });
		expect(await verifyLocal(fill("$DG_DEMO_PW"), unset.deps)).toEqual({
			ok: false,
			findings: [{ step: 2, kind: "env-unset", variable: "DG_DEMO_PW" }],
		});
		const set = opening({ dir }, { DG_DEMO_PW: "hunter2" });
		expect(await verifyLocal(fill("$DG_DEMO_PW"), set.deps)).toEqual({ ok: true, findings: [] });
		expect(set.browser.locators.get("#two")?.typed).toEqual(["hunter2"]);
	});

	test("names the step and variable when an env fill targets a non-password field", async () => {
		const { deps, browser } = opening({ dir, notPassword: ["#two"] }, { DG_DEMO_PW: "hunter2" });
		const result = await verifyLocal(
			{
				...script(),
				steps: [{ title: "User", body: "b", selector: "#two", action: { do: "fill", value: "$DG_DEMO_PW" } }],
			},
			deps,
		);
		expect(result).toEqual({
			ok: false,
			findings: [
				{ step: 1, kind: "harness-error", message: "step 1: $DG_DEMO_PW can only be typed into a password field" },
			],
		});
		expect(browser.locators.get("#two")?.typed).toEqual([]);
	});

	test("reports a typing failure on a resolved field as a harness error, not a selector", async () => {
		const { deps } = opening({ dir, untypable: ["#two"] });
		const result = await verifyLocal(
			{
				...script(),
				steps: [{ title: "Name", body: "b", selector: "#two", action: { do: "fill", value: "dante" } }],
			},
			deps,
		);
		expect(result).toEqual({
			ok: false,
			findings: [{ step: 1, kind: "harness-error", message: "step 1: could not type into #two" }],
		});
	});

	test("turns an open failure into a harness-error finding", async () => {
		const result = await verifyLocal(script(), {
			open: async () => {
				throw new Error("no browser");
			},
		});
		expect(result).toEqual({
			ok: false,
			findings: [{ step: 0, kind: "harness-error", message: "no browser" }],
		});
	});

	test("closes the session and reports a harness-error when the page throws", async () => {
		const closed: string[] = [];
		const result = await verifyLocal(script(), {
			open: async () => ({
				page: {
					viewportSize: () => null,
					goto: async () => {
						throw new Error("page crashed");
					},
				} as never,
				close: async () => void closed.push("closed"),
			}),
		});
		expect(result.findings[0]).toMatchObject({ kind: "harness-error", message: "page crashed" });
		expect(closed).toEqual(["closed"]);
	});

	test("never shows captions: the dry run skips every overlay", async () => {
		const { deps, browser } = opening({ dir });
		await verifyLocal(script(), deps);
		expect(browser.evaluated).toEqual([]);
	});
});

describe("verifyLocal with excluded setup", () => {
	const withSetup = (): TourScript => ({
		...script(),
		setup: {
			includeInTour: false,
			steps: [
				{ title: "S1", body: "a", selector: "#s1" },
				{ title: "S2", body: "b", selector: "#s2", navigate: "https://a.test/login" },
			],
		},
	});

	test("walks setup and tutorial as one flat sequence", async () => {
		const { deps } = opening({ dir, missing: ["#two"] });
		const result = await verifyLocal(withSetup(), deps);
		expect(result.findings).toEqual([{ step: 4, kind: "selector-unresolved", selector: "#two" }]);
	});

	test("returns to the start URL for the first tutorial step after setup moved away", async () => {
		const { deps, browser } = opening({ dir });
		await verifyLocal(withSetup(), deps);
		expect(browser.log.filter((line) => line.startsWith("goto "))).toEqual([
			"goto https://example.test/",
			"goto https://a.test/login",
			"goto https://example.test/",
		]);
	});

	test("returns to the start URL after setup even when setup moved only by a click", async () => {
		const { deps, browser } = opening({ dir, clickNavigates: { "#go": "https://example.test/home" } });
		await verifyLocal(
			{
				...script(),
				setup: {
					includeInTour: false,
					steps: [{ title: "Go", body: "a", selector: "#go", action: { do: "click" } }],
				},
			},
			deps,
		);
		expect(browser.log.filter((line) => line.startsWith("goto "))).toEqual([
			"goto https://example.test/",
			"goto https://example.test/",
		]);
	});

	test("leaves a first tutorial step that names its own URL alone", async () => {
		const base = withSetup();
		const { deps, browser } = opening({ dir });
		await verifyLocal(
			{ ...base, steps: [{ ...base.steps[0]!, navigate: "https://b.test/" }, base.steps[1]!] },
			deps,
		);
		expect(browser.log.filter((line) => line.startsWith("goto ")).at(-1)).toBe("goto https://b.test/");
	});

	test("adds no start navigation when setup is already part of the tour", async () => {
		const base = withSetup();
		const { deps, browser } = opening({ dir });
		await verifyLocal({ ...base, setup: { ...base.setup!, includeInTour: true } }, deps);
		expect(browser.log.filter((line) => line.startsWith("goto "))).toEqual([
			"goto https://example.test/",
			"goto https://a.test/login",
		]);
	});
});

const browser = process.env.PW_E2E === "1" ? findInstalledChromium() : null;

describe("verifyLocal in a real browser", () => {
	test.skipIf(!browser)("follows a click that submits a form and navigates", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/login" && req.method === "POST")
					return new Response(null, { status: 303, headers: { Location: "/home" } });
				const html =
					url.pathname === "/home"
						? '<!doctype html><h1 id="welcome">Welcome</h1>'
						: '<!doctype html><form method="post" action="/login"><input id="user" name="user"><button id="go" type="submit">Go</button></form>';
				return new Response(html, { headers: { "Content-Type": "text/html" } });
			},
		});
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const plan = (last: string): TourScript => ({
				startUrl: `${base}/`,
				steps: [
					{ title: "User", body: "Name.", selector: "#user", action: { do: "fill", value: "dante" } },
					{ title: "Go", body: "Submit.", selector: "#go", action: { do: "click" } },
					{ title: "Home", body: "Landed.", selector: last },
				],
			});
			expect(await verifyLocal(plan("#welcome"))).toEqual({ ok: true, findings: [] });
			expect((await verifyLocal(plan("#nope"))).findings).toEqual([
				{ step: 3, kind: "selector-unresolved", selector: "#nope" },
			]);
		} finally {
			server.stop(true);
		}
	});
});
