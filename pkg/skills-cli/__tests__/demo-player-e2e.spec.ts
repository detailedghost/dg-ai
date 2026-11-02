import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPlayer } from "../src/demo/player-process";
import { verifyLocal } from "../src/demo/verify-local";
import type { DemoResult } from "../src/demo/result";

const enabled = process.env.PW_E2E === "1";

describe.skipIf(!enabled)("__player --video against a local http server", () => {
	let dir: string;
	let server: ReturnType<typeof Bun.serve>;

	const previousHome = process.env.DG_HOME;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "dg-player-e2e-"));
		process.env.DG_HOME = join(dir, "dg-home");
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				new Response(
					'<!doctype html><h1 id="one">One</h1><p id="two">Two</p>',
					{ headers: { "content-type": "text/html" } },
				),
		});
	});
	afterAll(() => {
		server.stop(true);
		if (previousHome === undefined) delete process.env.DG_HOME;
		else process.env.DG_HOME = previousHome;
		rmSync(dir, { recursive: true, force: true });
	});

	test("records a webm, writes result.json and shows the overlay mid-run", async () => {
		const slug = "e2e-tour";
		const planPath = join(dir, `${slug}.demo.md`);
		writeFileSync(planPath, "");
		const shots: Array<{ withOverlay: Buffer; without: Buffer; text: string }> = [];
		const job = {
			slug,
			planPath,
			dir,
			video: true,
			profile: join(dir, "profile"),
			startUrl: `http://127.0.0.1:${server.port}/`,
			script: {
				title: "E2E Tour",
				startUrl: `http://127.0.0.1:${server.port}/`,
				mode: "video" as const,
				steps: [
					{ title: "First stop", body: "alpha", selector: "#one", advance: 600 },
					{ title: "Second stop", body: "beta", selector: "#two", advance: 600 },
				],
			},
		};
		await runPlayer(job, {
			onProgress: async (page, index) => {
				if (index !== 0) return;
				const hosts = "[id^='dg-']";
				const withOverlay = await page.screenshot();
				const text = await page.evaluate(
					(selector) =>
						[...document.querySelectorAll(selector)]
							.map((host) => host.shadowRoot?.textContent ?? "")
							.join("\n"),
					hosts,
				);
				await page.addStyleTag({ content: `${hosts} { display: none !important }` });
				const without = await page.screenshot();
				shots.push({ withOverlay, without, text });
			},
		});

		const files = readdirSync(dir);
		const webm = files.find((name) => /^e2e-tour-\d{8}-\d{4}\.webm$/.test(name));
		expect(webm).toBeDefined();
		expect(statSync(join(dir, webm as string)).size).toBeGreaterThan(1024);

		const result = JSON.parse(
			readFileSync(join(dir, `${slug}.result.json`), "utf8"),
		) as DemoResult;
		expect(result.outcome).toBe("done");
		expect(result.steps).toBe(2);

		expect(shots).toHaveLength(1);
		expect(shots[0]?.text).toContain("First stop");
		expect(shots[0]?.withOverlay.length).toBeGreaterThan(1024);
		expect(shots[0]?.withOverlay.equals(shots[0]?.without as Buffer)).toBe(false);
	}, 120_000);

	test("verifyLocal walks a plan through the real local adapter", async () => {
		const startUrl = `http://127.0.0.1:${server.port}/`;
		const plan = (second: string) => ({
			title: "Verify Tour",
			startUrl,
			steps: [
				{ title: "First stop", body: "alpha", selector: "#one" },
				{ title: "Second stop", body: "beta", selector: second },
			],
		});
		expect(await verifyLocal(plan("#two"))).toEqual({ ok: true, findings: [] });
		const missed = await verifyLocal(plan("#missing"));
		expect(missed.ok).toBe(false);
		expect(missed.findings).toEqual([
			{ step: 2, kind: "selector-unresolved", selector: "#missing" },
		]);
	}, 120_000);
});
