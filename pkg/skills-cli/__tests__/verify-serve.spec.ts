import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERIFY_JS } from "../src/verify/client";
import { parseManifest } from "../src/verify/manifest";
import { escapeHtml, renderReview, type ReviewModel } from "../src/verify/page";
import { saveManifest } from "../src/verify/session";
import { VERIFY_CSP, startVerifyServer, type RunningReview } from "../src/verify/serve";
import { verifyPaths, writeReload } from "../src/verify/verdict";

let server: RunningReview | undefined;
let dir = "";

afterEach(() => {
	server?.stop();
	server = undefined;
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

function model(overrides: Partial<ReviewModel> = {}): ReviewModel {
	return {
		name: "review",
		stackUrl: "http://127.0.0.1:3000/",
		token: "1",
		status: "pending",
		allApproved: false,
		claimed: false,
		httpEngine: true,
		items: [
			{
				id: "home",
				title: "Home <script>",
				owner: "dg:implementer",
				beforeRef: "master",
				afterRef: "feat/home",
				hasTarget: false,
				shots: [],
				axe: { tool: "dg-axe-summary", engine: "local-static", violations: [], passes: ["document-title"] },
				tests: { status: "passed", summary: "4 passed", exitCode: 0 },
			},
		],
		tests: { status: "passed", summary: "4 passed", exitCode: 0 },
		...overrides,
	};
}

describe("review document", () => {
	test("escapes item text and serves the picker without an inline script", () => {
		const html = renderReview(model());
		expect(html).toContain("&lt;script&gt;");
		expect(html.match(/<script\b[^>]*>/g)).toEqual(['<script src="/verify.js">']);
		expect(html).toContain('data-side="before"');
		expect(html).toContain('data-side="after"');
		expect(html).toContain('data-side="target"');
		expect(html).toContain("No prototype target for this item.");
		expect(html).toContain("Approve");
		expect(html).toContain("Reject");
		expect(html).toContain("Tweak");
		expect(html).toContain("Open the local stack");
		expect(html).toContain("HTTP engine");
		expect(html).not.toContain("onclick=");
		expect(html).not.toContain("<style");
		expect(escapeHtml(`a&b<"'>`)).toBe("a&amp;b&lt;&quot;&#39;&gt;");
	});

	test("the static client reloads the same tab and blocks an empty rework note", () => {
		expect(VERIFY_JS).toContain("location.reload");
		expect(VERIFY_JS).toContain("A note is required.");
		expect(VERIFY_JS).not.toContain("eval(");
		expect(VERIFY_JS).not.toContain("<script");
	});
});

describe("verify server", () => {
	async function boot(): Promise<string> {
		dir = mkdtempSync(join(tmpdir(), "dg-verify-serve-"));
		const paths = verifyPaths(dir);
		saveManifest(
			paths,
			parseManifest({
				name: "review",
				stackUrl: "http://127.0.0.1:9/",
				items: [
					{
						id: "home",
						title: "Home",
						owner: "dg:implementer",
						beforeUrl: "http://127.0.0.1:1/",
						afterUrl: "http://127.0.0.1:2/",
						roles: [{ id: "admin" }],
					},
				],
			}),
		);
		writeReload(paths, 1);
		server = await startVerifyServer({ paths, port: 0 });
		return `http://127.0.0.1:${server.port}`;
	}

	test("sends the strict CSP and the static script", async () => {
		const url = await boot();
		const page = await fetch(url);
		expect(page.headers.get("content-security-policy")).toBe(VERIFY_CSP);
		expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline");
		const html = await page.text();
		expect(html).toContain('src="/verify.js"');
		expect(html).not.toContain(VERIFY_JS);
		const script = await fetch(`${url}/verify.js`);
		expect(script.headers.get("content-type")).toContain("javascript");
		expect(await script.text()).toBe(VERIFY_JS);
		const style = await fetch(`${url}/verify.css`);
		expect(style.headers.get("content-type")).toContain("text/css");
	});

	test("records an approval and rejects a rework that has no note", async () => {
		const url = await boot();
		const headers = { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
		const missing = await fetch(`${url}/decision`, {
			method: "POST",
			headers,
			body: JSON.stringify({ itemId: "home", action: "reject", note: " " }),
		});
		expect(missing.status).toBe(400);
		expect(await missing.text()).toContain("a note is required");
		const approved = await fetch(`${url}/decision`, {
			method: "POST",
			headers,
			redirect: "manual",
			body: JSON.stringify({ itemId: "home", action: "approve", note: "" }),
		});
		expect(approved.status).toBe(303);
		const after = await (await fetch(url)).text();
		expect(after).toContain('data-overall="all-approved"');
		expect(after).toContain('data-all-approved="true"');
		expect(after).toContain('data-decision="approve"');
	});

	test("rejects a cross-site post, a plain body, and a shot path that escapes", async () => {
		const url = await boot();
		const cross = await fetch(`${url}/decision`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "https://example.com",
				"Sec-Fetch-Site": "cross-site",
			},
			body: JSON.stringify({ itemId: "home", action: "approve", note: "" }),
		});
		expect(cross.status).toBe(403);
		const plain = await fetch(`${url}/decision`, {
			method: "POST",
			headers: { "Content-Type": "text/plain", "Sec-Fetch-Site": "same-origin" },
			body: "itemId=home",
		});
		expect(plain.status).toBe(415);
		expect((await fetch(`${url}/shots/../../etc/passwd`)).status).toBe(404);
		expect((await fetch(`${url}/shots/home/before/admin/desktop/light/default.png`)).status).toBe(404);
		expect((await fetch(url, { method: "PUT" })).status).toBe(405);
	});
});
