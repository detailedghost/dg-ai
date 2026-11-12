import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlayerJob } from "../src/demo/player-job";
import { openSession } from "../src/demo/player-process";
import { findInstalledChromium } from "../src/utils/find-browser";

setDefaultTimeout(90_000);

const executablePath = process.env.PW_E2E === "1" ? findInstalledChromium() : null;

describe.skipIf(!executablePath)("the local launcher keeps a sign-in across contexts", () => {
	let dir: string;
	let server: ReturnType<typeof Bun.serve>;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "dg-local-session-"));
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				const headers = { "Content-Type": "text/html" } as Record<string, string>;
				if (url.pathname === "/login") headers["Set-Cookie"] = "sid=abc; Path=/";
				const body =
					url.pathname === "/login"
						? "<script>localStorage.setItem('token','t1')</script>in"
						: url.pathname === "/logout"
							? "<script>localStorage.removeItem('token')</script>out"
							: `<script>document.title = document.cookie + '|' + localStorage.getItem('token')</script>`;
				return new Response(body, { headers });
			},
		});
	});
	afterAll(() => {
		server.stop(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("restores cookies and local storage from the setup context's state", async () => {
		const job: PlayerJob = {
			slug: "s",
			planPath: join(dir, "p.md"),
			dir,
			startUrl: `http://127.0.0.1:${server.port}/`,
			script: { startUrl: `http://127.0.0.1:${server.port}/`, steps: [{ body: "a" }] },
			profile: join(dir, "profile"),
			plan: {
				mode: "local",
				headless: true,
				pick: { executablePath: executablePath as string },
				label: "chromium",
			},
		};
		const session = await openSession(job);
		try {
			const setup = await session.open(false);
			const login = await setup.newPage();
			await login.goto(`http://127.0.0.1:${server.port}/login`);
			const state = await setup.storageState();
			await setup.close();

			const recording = await session.open(true, state);
			const page = await recording.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/whoami`);
			expect(await page.title()).toBe("sid=abc|t1");
			await page.goto(`http://127.0.0.1:${server.port}/logout`);
			await page.goto(`http://127.0.0.1:${server.port}/whoami`);
			expect(await page.title()).toBe("sid=abc|null");
		} finally {
			await session.close();
		}
	});
});
