import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSession } from "../src/verify/capture";
import { createHttpCapturer } from "../src/verify/http-capturer";
import { main } from "../src/verify";
import { parseManifest } from "../src/verify/manifest";
import { loadManifest, saveManifest } from "../src/verify/session";
import { startVerifyServer, type RunningReview } from "../src/verify/serve";
import { verifyPaths, writeReload } from "../src/verify/verdict";

setDefaultTimeout(30_000);

interface App {
	url: string;
	hits: { path: string; role: string; theme: string; state: string }[];
	stop(): void;
}

function startApp(kind: "before" | "after" | "target"): App {
	const hits: App["hits"] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const role = req.headers.get("x-seed-role") ?? "missing";
			const theme = url.searchParams.get("dg-theme") ?? "missing";
			const state = url.searchParams.get("dg-state") ?? "missing";
			hits.push({ path: url.pathname, role, theme, state });
			const dirty = kind === "after" && url.pathname === "/";
			const field = dirty
				? `<input id="q">`
				: `<label for="q">Query</label><input id="q">`;
			const html = `<!doctype html><html lang="en" data-theme="${theme}" data-scrolled="${state === "scrolled" ? "true" : "false"}"><head><title>${kind} ${url.pathname}</title></head><body><h1>${kind} ${url.pathname}</h1><p>${role === "admin" ? "Admin tools" : "Member tools"}</p><button type="button" data-verify-menu aria-expanded="${state === "menu" ? "true" : "false"}">Open menu</button>${field}<div style="height:2400px">spacer</div></body></html>`;
			return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}`,
		hits,
		stop() {
			server.stop(true);
		},
	};
}

async function stdoutOf(run: () => Promise<number | undefined>): Promise<{ code: number | undefined; out: string }> {
	const chunks: string[] = [];
	const original = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
		return true;
	}) as typeof process.stdout.write;
	try {
		return { code: await run(), out: chunks.join("") };
	} finally {
		process.stdout.write = original;
	}
}

describe("verify review", () => {
	const apps: App[] = [];
	let server: RunningReview | undefined;
	let dir = "";

	afterEach(() => {
		server?.stop();
		server = undefined;
		for (const app of apps) app.stop();
		apps.length = 0;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	test("captures both roles, serves before and after beside a prototype, and reruns only the tweaked item", async () => {
		const before = startApp("before");
		const after = startApp("after");
		const target = startApp("target");
		apps.push(before, after, target);
		dir = mkdtempSync(join(tmpdir(), "dg-verify-review-"));
		const manifest = {
			name: "review",
			stackUrl: `${after.url}/`,
			tests: { summary: "4 passed", passed: 4, failed: 0 },
			items: [
				{
					id: "home",
					title: "Home",
					owner: "dg:implementer",
					beforeRef: "master",
					afterRef: "feat/home",
					beforeUrl: `${before.url}/`,
					afterUrl: `${after.url}/`,
					targetUrl: `${target.url}/`,
					roles: [
						{ id: "admin", headers: { "x-seed-role": "admin" } },
						{ id: "member", headers: { "x-seed-role": "member" } },
					],
				},
				{
					id: "settings",
					title: "Settings",
					owner: "bc-owner",
					beforeUrl: `${before.url}/settings`,
					afterUrl: `${after.url}/settings`,
					roles: [
						{ id: "admin", headers: { "x-seed-role": "admin" } },
						{ id: "member", headers: { "x-seed-role": "member" } },
					],
				},
			],
		};
		const manifestFile = join(dir, "manifest.json");
		writeFileSync(manifestFile, JSON.stringify(manifest));
		const paths = verifyPaths(dir);
		const capturer = createHttpCapturer();
		try {
			const captured = await captureSession({
				manifest: parseManifest(manifest),
				paths,
				capturer,
				cwd: dir,
			});
			expect(captured.shots).toBe(120);
		} finally {
			await capturer.close();
		}
		expect(before.hits.filter((hit) => hit.path === "/")).toHaveLength(24);
		expect(before.hits.filter((hit) => hit.path === "/settings")).toHaveLength(24);
		expect(before.hits.some((hit) => hit.role === "admin" && hit.theme === "dark" && hit.state === "scrolled")).toBe(
			true,
		);
		expect(before.hits.some((hit) => hit.role === "member" && hit.state === "menu")).toBe(true);
		expect(target.hits).toHaveLength(24);
		const targetHits = target.hits.length;
		const sidecar = JSON.parse(
			readFileSync(join(dir, "shots/home/after/member/mobile/dark/scrolled.json"), "utf8"),
		) as { width: number; height: number; scrolled: boolean; engine: string; menuFound: boolean };
		expect(sidecar).toMatchObject({ width: 390, height: 844, scrolled: true, engine: "http" });
		const menu = JSON.parse(
			readFileSync(join(dir, "shots/home/before/admin/desktop/light/menu.json"), "utf8"),
		) as { menuFound: boolean; width: number };
		expect(menu.menuFound).toBe(true);
		expect(menu.width).toBe(1440);
		const homeShot = join(dir, "shots/home/before/admin/desktop/light/default.png");
		const homeMtime = statSync(homeShot).mtimeMs;
		writeReload(paths, 1);
		server = await startVerifyServer({ paths, port: 0 });
		const url = `http://127.0.0.1:${server.port}`;
		const html = await (await fetch(url)).text();
		expect(html).toContain("Open the local stack");
		expect(html).toContain(after.url);
		expect(html).toContain('data-side="before"');
		expect(html).toContain('data-side="after"');
		expect(html).toContain('data-side="target"');
		expect(html).toContain("No prototype target for this item.");
		expect(html).toContain("html fetch");
		expect(html).not.toContain("menu not found");
		expect(html).not.toContain("page did not scroll");
		expect(html).toContain("4 passed");
		const home = html.split('data-item="settings"')[0] ?? "";
		const settings = html.split('data-item="settings"')[1] ?? "";
		expect(home).toContain('data-axe-id="label"');
		expect(home).toContain('data-axe-violations="1"');
		expect(home).toContain('data-axe-passes="6"');
		expect(settings).toContain('data-axe-violations="0"');
		expect(settings).toContain('data-axe-passes="7"');
		const headers = { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
		expect(
			(
				await fetch(`${url}/decision`, {
					method: "POST",
					headers,
					redirect: "manual",
					body: JSON.stringify({ itemId: "home", action: "approve", note: "" }),
				})
			).status,
		).toBe(303);
		const form = await fetch(`${url}/decision`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
			redirect: "manual",
			body: "itemId=settings&action=tweak&note=The+menu+clips+on+mobile",
		});
		expect(form.status).toBe(303);
		const status = await stdoutOf(() =>
			main(["status", "review", `--dir=${dir}`, "--json"]),
		);
		expect(status.code).toBe(0);
		const report = JSON.parse(status.out) as {
			status: string;
			allApproved: boolean;
			notifications: { itemId: string; owner: string; action: string; note: string }[];
		};
		expect(report.status).toBe("needs-rework");
		expect(report.allApproved).toBe(false);
		expect(report.notifications).toEqual([
			{
				itemId: "settings",
				owner: "bc-owner",
				action: "tweak",
				note: "The menu clips on mobile",
			},
		]);
		const claimed = await stdoutOf(() => main(["wait", "review", `--dir=${dir}`, "--timeout=0", "--json"]));
		expect(claimed.code).toBe(0);
		expect(JSON.parse(claimed.out).allApproved).toBe(false);
		const again = await stdoutOf(() => main(["wait", "review", `--dir=${dir}`, "--timeout=0"]));
		expect(again.code).toBe(0);
		expect(again.out).toContain("settings tweak owner=bc-owner");
		expect(again.out).toContain("allApproved false");
		const locked = await fetch(`${url}/decision`, {
			method: "POST",
			headers,
			body: JSON.stringify({ itemId: "settings", action: "approve", note: "" }),
		});
		expect(locked.status).toBe(409);
		const beforeSettings = before.hits.filter((hit) => hit.path === "/settings").length;
		const beforeHome = before.hits.filter((hit) => hit.path === "/").length;
		const rerun = await stdoutOf(() => main(["rerun", "review", `--dir=${dir}`, "--engine=http"]));
		expect(rerun.code).toBe(0);
		expect(rerun.out).toContain("recaptured settings");
		expect(before.hits.filter((hit) => hit.path === "/settings").length).toBe(beforeSettings + 24);
		expect(before.hits.filter((hit) => hit.path === "/").length).toBe(beforeHome);
		expect(target.hits.length).toBe(targetHits);
		expect(statSync(homeShot).mtimeMs).toBe(homeMtime);
		expect((await (await fetch(`${url}/reload`)).json()) as { token: string }).toEqual({ token: "2" });
		const reopened = await stdoutOf(() => main(["status", "review", `--dir=${dir}`]));
		expect(reopened.out).toContain("settings pending owner=bc-owner");
		expect(reopened.out).toContain("home approve owner=dg:implementer");
		expect(reopened.out).toContain("allApproved false");
		const repo = join(import.meta.dir, "../../..");
		const ignored = Bun.spawnSync(["git", "check-ignore", "-q", ".agents/verify/demo/shots/a.png"], {
			cwd: repo,
		});
		expect(ignored.exitCode).toBe(0);
		expect(readFileSync(join(repo, ".gitignore"), "utf8")).toContain(".agents/verify/");
	});

	test("help lists the five commands and a missing session fails", async () => {
		const help = await stdoutOf(() => main(["--help"]));
		expect(help.code).toBe(0);
		for (const command of ["start", "capture", "status", "wait", "rerun"])
			expect(help.out).toContain(command);
		dir = mkdtempSync(join(tmpdir(), "dg-verify-missing-"));
		const missing = await stdoutOf(() => main(["status", "review", `--dir=${dir}`]));
		expect(missing.code).toBe(1);
	});
});

describe("session manifest", () => {
	test("save and load round-trip the parsed manifest", () => {
		const saved = mkdtempSync(join(tmpdir(), "dg-verify-save-"));
		try {
			const paths = verifyPaths(saved);
			saveManifest(
				paths,
				parseManifest({
					name: "review",
					stackUrl: "http://127.0.0.1:1/",
					items: [
						{
							id: "home",
							title: "Home",
							owner: "dg:implementer",
							beforeUrl: "http://127.0.0.1:2/",
							afterUrl: "http://127.0.0.1:3/",
							roles: [{ id: "admin" }],
						},
					],
				}),
			);
			expect(loadManifest(paths).items[0]?.menuSelector).toBe("[data-verify-menu]");
		} finally {
			rmSync(saved, { recursive: true, force: true });
		}
	});
});
