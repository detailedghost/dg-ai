import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVerdicts, verifyPaths, writeBoard } from "../src/verify/board";
import { VERIFY_CSP, startVerifyServer, type RunningReview } from "../src/verify/serve";

let server: RunningReview | undefined;
let dir = "";

afterEach(() => {
	server?.stop();
	server = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

const ASSETS = join(import.meta.dir, "../../../plugins/dg/skills/verify/assets");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function boot(): Promise<string> {
	dir = mkdtempSync(join(tmpdir(), "dg-verify-serve-"));
	const paths = verifyPaths(dir);
	writeBoard(paths, {
		name: "review",
		sections: [{ id: "home-r1", title: "Home", images: [{ label: "desktop · a", before: "missing", after: "/shots/home-r1/a.png" }] }],
		pending: [{ key: "nav-r1", title: "Nav" }],
	});
	mkdirSync(join(paths.shotsDir, "home-r1"), { recursive: true });
	writeFileSync(join(paths.shotsDir, "home-r1", "a.png"), PNG);
	writeFileSync(join(dir, "secret.png"), PNG);
	server = await startVerifyServer({ name: "review", paths, port: 0 });
	return `http://127.0.0.1:${server.port}`;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${url}/api/verdicts`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: url, "Sec-Fetch-Site": "same-origin", ...headers },
		body: JSON.stringify(body),
	});

describe("verify server", () => {
	test("serves the board template with the strict CSP and no inline script or style", async () => {
		const url = await boot();
		const page = await fetch(url);
		expect(page.headers.get("content-security-policy")).toBe(VERIFY_CSP);
		expect(VERIFY_CSP).toContain("script-src 'self';");
		expect(VERIFY_CSP).toContain("img-src 'self' data:;");
		const html = await page.text();
		expect(html).toBe(readFileSync(join(ASSETS, "index.html"), "utf8"));
		expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script src="/board/icons.js">', '<script src="/board/board.js">']);
		expect(html).not.toContain("<style");
		expect(html).not.toMatch(/\son[a-z]+=/);
		const script = await fetch(`${url}/board/board.js`);
		expect(script.headers.get("content-type")).toContain("javascript");
		expect(await script.text()).toBe(readFileSync(join(ASSETS, "board.js"), "utf8"));
		expect((await fetch(`${url}/board/board.css`)).headers.get("content-type")).toContain("text/css");
		const icons = await (await fetch(`${url}/board/icons.js`)).text();
		expect(icons).toBe(readFileSync(join(ASSETS, "../../proto/assets/dg-icons.js"), "utf8"));
		expect(icons).toContain("globalThis.dgIcons");
		expect((await fetch(`${url}/board/server.ts`)).status).toBe(404);
	});

	test("returns the board manifest and serves a shot inside the session", async () => {
		const url = await boot();
		const board = (await (await fetch(`${url}/api/manifest?name=review`)).json()) as { sections: unknown[]; pending: unknown[] };
		expect(board.sections).toHaveLength(1);
		expect(board.pending).toHaveLength(1);
		const shot = await fetch(`${url}/shots/home-r1/a.png`);
		expect(shot.status).toBe(200);
		expect(shot.headers.get("content-type")).toBe("image/png");
		expect((await fetch(`${url}/shots/../secret.png`)).status).toBe(404);
		expect((await fetch(`${url}/shots/home-r1/%2e%2e/%2e%2e/secret.png`)).status).toBe(404);
		expect((await fetch(`${url}/shots/home-r1/missing.png`)).status).toBe(404);
	});

	test("merges a verdict and refuses a rework with no note", async () => {
		const url = await boot();
		expect((await post(url, { "home-r1": { status: "changes", note: " " } })).status).toBe(400);
		const saved = await post(url, { "home-r1": { status: "approved", note: "tidy", at: "ignored" } });
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual({ ok: true });
		const stored = readVerdicts(verifyPaths(dir));
		expect(stored["home-r1"]).toMatchObject({ status: "approved", note: "tidy" });
		expect(stored["home-r1"]?.at).not.toBe("ignored");
		expect(await (await fetch(`${url}/api/verdicts`)).json()).toEqual(JSON.parse(JSON.stringify(stored)));
	});

	test("refuses a cross-site post, a form body, a foreign host, and other methods", async () => {
		const url = await boot();
		expect((await post(url, {}, { Origin: "https://example.com", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
		expect((await post(url, {}, { "Sec-Fetch-Site": "same-site" })).status).toBe(403);
		const form = await fetch(`${url}/api/verdicts`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
			body: "home-r1=approved",
		});
		expect(form.status).toBe(415);
		expect((await fetch(url, { headers: { Host: "evil.test" } })).status).toBe(403);
		expect((await fetch(url, { method: "PUT" })).status).toBe(405);
		expect(readVerdicts(verifyPaths(dir))).toEqual({});
	});
});
