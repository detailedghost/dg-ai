import { describe, expect, test } from "bun:test";
import {
	STATES,
	THEMES,
	VIEWPORTS,
	menuIsOpen,
	pageMarkedScrolled,
	pngSize,
	withCaptureQuery,
} from "../src/verify/capture-model";
import { createHttpCapturer } from "../src/verify/http-capturer";
import { assertArgv, runDeclaredTests } from "../src/verify/tests-run";

describe("capture matrix", () => {
	test("uses desktop 1440, tablet 768, and mobile 390, both themes, and the scrolled and menu states", () => {
		expect(VIEWPORTS.map((viewport) => [viewport.id, viewport.width, viewport.height])).toEqual([
			["desktop", 1440, 900],
			["tablet", 768, 1024],
			["mobile", 390, 844],
		]);
		expect(THEMES).toEqual(["light", "dark"]);
		expect(STATES).toEqual(["default", "scrolled", "menu"]);
	});

	test("adds the theme and state to the captured url", () => {
		expect(withCaptureQuery("http://127.0.0.1:9/settings?x=1", "dark", "menu")).toBe(
			"http://127.0.0.1:9/settings?x=1&dg-theme=dark&dg-state=menu",
		);
	});

	test("sees an open menu in either attribute order and a scroll marker", () => {
		expect(menuIsOpen('<button data-verify-menu aria-expanded="true">Open</button>')).toBe(true);
		expect(menuIsOpen('<button aria-expanded="true" data-verify-menu>Open</button>')).toBe(true);
		expect(menuIsOpen('<button data-verify-menu aria-expanded="false">Open</button>')).toBe(false);
		expect(pageMarkedScrolled('<html data-scrolled="true">')).toBe(true);
		expect(pageMarkedScrolled('<html data-scrolled="false">')).toBe(false);
	});
});

describe("http capturer", () => {
	test("follows a loopback redirect and refuses an off-machine redirect", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/jump")
					return new Response(null, { status: 302, headers: { Location: "/land" } });
				if (url.pathname === "/leave")
					return new Response(null, { status: 302, headers: { Location: "https://example.com/nope" } });
				return new Response(
					`<html lang="en" data-scrolled="true"><title>Land</title><button data-verify-menu aria-expanded="true">Open</button></html>`,
					{ headers: { "Content-Type": "text/html" } },
				);
			},
		});
		const capturer = createHttpCapturer();
		try {
			const shot = await capturer.shot({
				url: `http://127.0.0.1:${server.port}/jump`,
				headers: { "x-seed-role": "admin" },
				cookies: [],
				width: 1440,
				height: 900,
				theme: "light",
				state: "menu",
				menuSelector: "[data-verify-menu]",
			});
			expect(shot.finalUrl).toContain("/land");
			expect(shot.menuFound).toBe(true);
			expect(shot.engine).toBe("http");
			expect(pngSize(shot.png)).toEqual({ width: 1, height: 1 });
			await expect(
				capturer.shot({
					url: `http://127.0.0.1:${server.port}/leave`,
					headers: {},
					cookies: [],
					width: 390,
					height: 844,
					theme: "dark",
					state: "default",
					menuSelector: "[data-verify-menu]",
				}),
			).rejects.toThrow(/refused a redirect to https:\/\/example.com/);
		} finally {
			await capturer.close();
			server.stop(true);
		}
	});

	test("sends the seed role header and cookie", async () => {
		let seen = "";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req) {
				seen = `${req.headers.get("x-seed-role")}|${req.headers.get("cookie")}`;
				return new Response("<html lang='en'><title>T</title></html>");
			},
		});
		const capturer = createHttpCapturer();
		try {
			await capturer.shot({
				url: `http://127.0.0.1:${server.port}/`,
				headers: { "x-seed-role": "member" },
				cookies: [{ name: "dg-seed-role", value: "member" }],
				width: 390,
				height: 844,
				theme: "dark",
				state: "scrolled",
				menuSelector: "[data-verify-menu]",
			});
			expect(seen).toBe("member|dg-seed-role=member");
		} finally {
			await capturer.close();
			server.stop(true);
		}
	});
});

describe("declared tests", () => {
	test("rejects a shell and a path", () => {
		expect(() => assertArgv(["bash", "-c", "true"])).toThrow(/shell/);
		expect(() => assertArgv(["sh"])).toThrow(/shell/);
		expect(() => assertArgv(["/usr/bin/bun"])).toThrow(/bare executable/);
		expect(() => assertArgv(["bun", "a\nb"])).toThrow(/single line/);
	});

	test("records a summary without spawning, and runs a bare argv", async () => {
		expect(await runDeclaredTests(undefined, process.cwd())).toEqual({
			status: "not-run",
			summary: "No test results supplied.",
			exitCode: null,
		});
		expect(await runDeclaredTests({ summary: "4 passed", failed: 0 }, process.cwd())).toMatchObject({
			status: "passed",
			summary: "4 passed",
		});
		expect(await runDeclaredTests({ summary: "1 failed", failed: 1 }, process.cwd())).toMatchObject({
			status: "failed",
		});
		const passed = await runDeclaredTests({ cmd: ["bun", "-e", "console.log('home tests ok')"] }, process.cwd());
		expect(passed.status).toBe("passed");
		expect(passed.summary).toContain("home tests ok");
		const failed = await runDeclaredTests({ cmd: ["bun", "-e", "process.exit(2)"] }, process.cwd());
		expect(failed.status).toBe("failed");
		expect(failed.exitCode).toBe(2);
	});

	test("clips command output at 4000 characters and kills a stuck command", async () => {
		const long = await runDeclaredTests(
			{ cmd: ["bun", "-e", "console.log('x'.repeat(5000))"] },
			process.cwd(),
		);
		expect(long.summary).toHaveLength(4000);
		const stuck = await runDeclaredTests(
			{ cmd: ["bun", "-e", "setTimeout(() => {}, 10000)"] },
			process.cwd(),
			300,
		);
		expect(stuck.status).toBe("failed");
		expect(stuck.exitCode).not.toBe(0);
	}, 10_000);
});
