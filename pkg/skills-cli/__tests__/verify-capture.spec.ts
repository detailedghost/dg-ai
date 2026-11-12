import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlRow, Reading } from "../src/layout/fingerprint";
import { captureSession, sectionFromCapture } from "../src/verify/capture";
import { verifyPaths } from "../src/verify/board";
import { parseManifest } from "../src/verify/manifest";
import { protoDir } from "../src/prototype/paths";
import {
	type Capturer,
	type CaptureRequest,
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

	test("fails a shot when the stack never finishes its body", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("<html>")) }));
			},
		});
		const capturer = createHttpCapturer(200);
		const started = Date.now();
		try {
			const shot = capturer.shot({
				url: `http://127.0.0.1:${server.port}/`,
				headers: {},
				cookies: [],
				width: 390,
				height: 844,
				theme: "light",
				state: "default",
				menuSelector: "[data-verify-menu]",
			});
			await expect(shot).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(3000);
		} finally {
			await capturer.close();
			server.stop(true);
		}
	});
});

describe("declared tests", () => {
	test("rejects a path and a multi-line argument", () => {
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

	test("keeps the last 4000 characters of output and kills a stuck command with its children", async () => {
		const long = await runDeclaredTests(
			{ cmd: ["bun", "-e", "console.log('x'.repeat(20000) + 'TOTALS 3 failed')"] },
			process.cwd(),
		);
		expect(long.summary).toHaveLength(4000);
		expect(long.summary.endsWith("TOTALS 3 failed")).toBe(true);
		const started = Date.now();
		const stuck = await runDeclaredTests({ cmd: ["env", "sh", "-c", "sleep 8 & sleep 8"] }, process.cwd(), 300);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(stuck.status).toBe("failed");
		expect(stuck.exitCode).not.toBe(0);
	}, 10_000);
});

describe("layout capture", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ROOT = { x: 0, y: 0, w: 800, h: 1000 };

	function control(band: ControlRow["band"], y: number): ControlRow {
		return {
			i: 0,
			role: "button",
			name: "Add note",
			testid: null,
			path: `button.add-${band}`,
			box: { x: 0, y, w: 100, h: 40 },
			band,
			hband: "left",
			visible: true,
			occluded: false,
			occluder: null,
		};
	}

	function readings(row: ControlRow): Reading[] {
		return (["desktop", "tablet", "mobile"] as const).flatMap((viewport) =>
			(["light", "dark"] as const).map((theme) => ({
				viewport,
				width: 1,
				height: 1,
				theme,
				themeApplied: theme,
				root: ROOT,
				controls: [row],
			})),
		);
	}

	function recordJson(extra: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			version: 1,
			name: "notes",
			chain: "notes",
			mode: "local",
			variant: "D",
			round: 1,
			notes: "",
			final: true,
			source: "browser",
			at: "2026-11-03T00:00:00Z",
			url: "http://127.0.0.1:4321/",
			root: '[data-verify-root="notes"]',
			fingerprint: { version: 1, root: '[data-verify-root="notes"]', readings: readings(control("bottom", 900)) },
			skipped: null,
			shots: "accepted/",
			history: [],
			...extra,
		};
	}

	function setup(record: Record<string, unknown> | string | undefined, extraItem: Record<string, unknown> = {}) {
		dir = mkdtempSync(join(tmpdir(), "dg-verify-layout-"));
		if (record !== undefined)
			writeFileSync(join(dir, "record.json"), typeof record === "string" ? record : JSON.stringify(record));
		const manifest = parseManifest({
			name: "review",
			stackUrl: "http://127.0.0.1:3000/",
			items: [
				{
					id: "notes",
					title: "Notes",
					owner: "dg:js",
					beforeUrl: "http://127.0.0.1:4001/",
					afterUrl: "http://127.0.0.1:4002/",
					record: "record.json",
					roles: [{ id: "admin" }],
					...extraItem,
				},
			],
		});
		return { manifest, paths: verifyPaths(join(dir, "session")) };
	}

	function fake(found: ControlRow, engine: "http" | "playwright" = "playwright") {
		const requests: CaptureRequest[] = [];
		const capturer: Capturer = {
			async shot(request) {
				requests.push(request);
				return {
					png: PNG,
					html: "<html lang='en'><title>t</title></html>",
					finalUrl: request.url,
					menuFound: false,
					scrolled: false,
					engine,
					...(request.fingerprintRoot && engine === "playwright"
						? { fingerprint: { root: ROOT, controls: [found], themeApplied: request.theme } }
						: {}),
				};
			},
			async close() {},
		};
		return { capturer, requests };
	}

	const run = (setupResult: ReturnType<typeof setup>, capturer: Capturer) =>
		captureSession({
			manifest: setupResult.manifest,
			paths: setupResult.paths,
			capturer,
			cwd: dir,
			targets: [{ itemId: "notes", sectionId: "notes-r1" }],
		});

	test("names a missing record and takes no shot", async () => {
		const ready = setup(undefined);
		const { capturer, requests } = fake(control("top", 20));
		await expect(run(ready, capturer)).rejects.toThrow(/record\.json/);
		expect(requests).toHaveLength(0);
	});

	test("refuses a malformed record before any shot", async () => {
		const ready = setup("{ not json");
		const { capturer, requests } = fake(control("top", 20));
		await expect(run(ready, capturer)).rejects.toThrow(/unreadable accepted record/);
		expect(requests).toHaveLength(0);
		const wrong = setup({ version: 2 });
		await expect(run(wrong, capturer)).rejects.toThrow(/unreadable accepted record/);
		expect(requests).toHaveLength(0);
	});

	test("fingerprints only the after side in the default state and fails on a moved control", async () => {
		const ready = setup(recordJson());
		const { capturer, requests } = fake(control("top", 20));
		const [captured] = await run(ready, capturer);
		const asked = requests.filter((request) => request.fingerprintRoot);
		expect(asked).toHaveLength(6);
		expect(asked.every((request) => request.url === "http://127.0.0.1:4002/" && request.state === "default")).toBe(true);
		expect(asked[0]?.fingerprintRoot).toBe("[data-verify-root]");
		const section = sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 });
		const layout = section.checks?.layout;
		expect(layout?.status).toBe("fail");
		expect(layout?.differences).toHaveLength(6);
		expect(layout?.differences[0]).toMatchObject({
			kind: "moved",
			role: "admin",
			expected: { path: "button.add-bottom", band: "bottom" },
			found: { path: "button.add-top", band: "top" },
		});
		expect(new Set(layout?.differences.map((row) => row.id)).size).toBe(6);
	});

	test("passes when the build matches the accepted layout", async () => {
		const ready = setup(recordJson());
		const { capturer } = fake(control("bottom", 900));
		const [captured] = await run(ready, capturer);
		expect(sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 }).checks?.layout).toEqual({
			status: "pass",
			differences: [],
		});
	});

	test("reports root-missing with the page reason when the build has no feature root", async () => {
		const ready = setup(recordJson());
		const { capturer } = fake(control("bottom", 900));
		const missing: Capturer = {
			async shot(request) {
				const shot = await capturer.shot(request);
				return request.fingerprintRoot ? { ...shot, fingerprint: { error: "root: found 0 visible [data-verify-root]" } } : shot;
			},
			async close() {},
		};
		const [captured] = await run(ready, missing);
		const rows = sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 }).checks?.layout?.differences ?? [];
		expect(rows).toHaveLength(6);
		expect(rows[0]).toMatchObject({ kind: "root-missing", reason: "root: found 0 visible [data-verify-root]" });
	});

	test("gives one not-checked row per role for the http engine", async () => {
		const ready = setup(recordJson());
		const { capturer } = fake(control("bottom", 900), "http");
		const [captured] = await run(ready, capturer);
		const layout = sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 }).checks?.layout;
		expect(layout?.status).toBe("not-checked");
		expect(layout?.differences).toHaveLength(1);
		expect(layout?.differences[0]).toMatchObject({ kind: "not-checked", role: "admin", reason: "http engine reads no layout" });
	});

	test("gives one not-checked row with the skipped reason when the record has no fingerprint", async () => {
		const ready = setup(recordJson({ fingerprint: null, skipped: "ext: the variation lives in the user's browser session" }));
		const { capturer, requests } = fake(control("bottom", 900));
		const [captured] = await run(ready, capturer);
		expect(requests.some((request) => request.fingerprintRoot)).toBe(false);
		const layout = sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 }).checks?.layout;
		expect(layout?.differences).toHaveLength(1);
		expect(layout?.differences[0]).toMatchObject({
			kind: "not-checked",
			reason: "ext: the variation lives in the user's browser session",
		});
	});

	test("leaves layout out of the section when the item has no record", async () => {
		const ready = setup(undefined, { record: undefined });
		const { capturer, requests } = fake(control("bottom", 900));
		const [captured] = await run(ready, capturer);
		expect(requests.some((request) => request.fingerprintRoot)).toBe(false);
		expect(sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 }).checks?.layout).toBeUndefined();
	});

	test("uses the recorded reference shots as target images when no target url is set", async () => {
		const ready = setup(recordJson());
		const shots = join(dir, ".agents", "prototype", "notes", "accepted");
		mkdirSync(shots, { recursive: true });
		for (const viewport of ["desktop", "tablet", "mobile"])
			for (const theme of ["light", "dark"]) writeFileSync(join(shots, `${viewport}-${theme}.png`), PNG);
		const { capturer } = fake(control("bottom", 900));
		const [captured] = await run(ready, capturer);
		const section = sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 });
		const defaults = section.images.filter((image) => image.label.endsWith("default"));
		expect(defaults).toHaveLength(6);
		expect(defaults.every((image) => image.target?.includes("/target/admin/"))).toBe(true);
		const target = defaults[0]?.target as string;
		expect(existsSync(join(ready.paths.shotsDir, target.replace("/shots/", "")))).toBe(true);
		expect(section.images.filter((image) => image.target)).toHaveLength(6);
	});

	test("uses the reference shots of a light prototype from the scratch sandbox", async () => {
		const ready = setup(recordJson());
		const previous = process.env.AI_SCRATCH_DIR;
		process.env.AI_SCRATCH_DIR = join(dir, "scratch");
		try {
			const shots = join(protoDir("notes", { cwd: dir, light: true }), "accepted");
			mkdirSync(shots, { recursive: true });
			for (const viewport of ["desktop", "tablet", "mobile"])
				for (const theme of ["light", "dark"]) writeFileSync(join(shots, `${viewport}-${theme}.png`), PNG);
			const { capturer } = fake(control("bottom", 900));
			const [captured] = await run(ready, capturer);
			const section = sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 });
			expect(section.images.filter((image) => image.target)).toHaveLength(6);
		} finally {
			if (previous === undefined) delete process.env.AI_SCRATCH_DIR;
			else process.env.AI_SCRATCH_DIR = previous;
		}
	});

	test("skips reference shots silently when the sandbox is absent", async () => {
		const ready = setup(recordJson());
		const { capturer } = fake(control("bottom", 900));
		const [captured] = await run(ready, capturer);
		const section = sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 });
		expect(section.images.some((image) => image.target)).toBe(false);
	});

	test("skips reference shots silently when the prototype name is ambiguous", async () => {
		const ready = setup(recordJson());
		const git = (args: string[], cwd: string) => Bun.spawnSync(["git", ...args], { cwd, stderr: "ignore" });
		const main = join(dir, "main");
		mkdirSync(main);
		git(["init", "-q"], main);
		git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i"], main);
		git(["worktree", "add", "-q", join(dir, "other")], main);
		for (const root of [main, join(dir, "other")]) {
			mkdirSync(join(root, ".agents", "prototype", "notes", "accepted"), { recursive: true });
			writeFileSync(join(root, ".agents", "prototype", "notes", "accepted", "desktop-light.png"), PNG);
		}
		writeFileSync(join(main, "record.json"), JSON.stringify(recordJson()));
		const { capturer } = fake(control("bottom", 900));
		const [captured] = await captureSession({
			manifest: ready.manifest,
			paths: ready.paths,
			capturer,
			cwd: main,
			targets: [{ itemId: "notes", sectionId: "notes-r1" }],
		});
		const section = sectionFromCapture(captured as NonNullable<typeof captured>, { round: 1 });
		expect(section.images.some((image) => image.target)).toBe(false);
		expect(section.checks?.layout?.status).toBe("pass");
	});

	test("keeps an explicit prototype target over the recorded shots", async () => {
		const ready = setup(recordJson(), { targetUrl: "http://127.0.0.1:4321/?variant=D" });
		const shots = join(dir, ".agents", "prototype", "notes", "accepted");
		mkdirSync(shots, { recursive: true });
		writeFileSync(join(shots, "desktop-light.png"), PNG);
		const { capturer, requests } = fake(control("bottom", 900));
		await run(ready, capturer);
		expect(requests.some((request) => request.url.startsWith("http://127.0.0.1:4321/"))).toBe(true);
		expect(readFileSync(join(ready.paths.shotsDir, "notes-r1", "target", "admin", "desktop", "light", "default.png"))).toEqual(Buffer.from(PNG));
	});
});
