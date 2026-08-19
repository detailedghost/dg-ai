/**
 * GET /assets/:id — the real wire contract pkg/extension/lib/features/
 * chat-transcript.ts's defaultFetchAsset already calls verbatim (that route,
 * those exact header names) — this is the daemon-side half. Registers assets
 * by opening a second ChatStore against the SAME DG_HOME the running daemon
 * uses (WAL supports the extra reader/writer), so the row/bytes exist
 * without depending on slice 7's `stage` CLI action ever being wired to this
 * slice's write-path.
 *
 * [SPEC] ASSUMED: the route/headers are NOT invented here — matching already-
 * shipped client code (chat-transcript.ts:64,67-68) exactly. The response
 * status/body-reason shape for each refusal IS this pass's invention; see
 * deferrals.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { registerAsset } from "../../src/assets/register";
import { ChatStore } from "../../src/store";
import { runCli } from "../commands/cli-wire";
import {
	allocatePort,
	cleanupDgHome,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	waitForHealth,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
});

async function bootWithAsset(input: {
	id: string;
	filename: string;
	contentType: string;
	bytes: Buffer;
}) {
	dgHome = freshDgHome();
	const port = allocatePort();
	const result = await runStart(dgHome, port);
	await waitForHealth(port);
	const bootstrap = validateSessionBootstrap(
		decodeChatMarker(extractUrl(result.stdout)),
	);

	const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
	const store = await ChatStore.open(paths, { env: { DG_KEY_SOURCE: "file" } });
	await registerAsset(
		{ paths, store },
		{ sessionId: bootstrap.sessionId, ...input },
	);
	store.close();

	return { port, bootstrap, paths };
}

function assetUrl(port: number, id: string): string {
	return `http://127.0.0.1:${port}/assets/${encodeURIComponent(id)}`;
}

describe("GET /assets/:id", () => {
	it("serves a staged asset's bytes given the owning session's valid header credential", async () => {
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const { port, bootstrap } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: png,
		});

		const resp = await fetch(assetUrl(port, "asset-1"), {
			headers: {
				Host: `127.0.0.1:${port}`,
				"X-Dg-Session-Id": bootstrap.sessionId,
				"X-Dg-Session-Token": bootstrap.token,
			},
		});

		expect(resp.status).toBe(200);
		expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
		const body = Buffer.from(await resp.arrayBuffer());
		expect(body.equals(png)).toBe(true);
	});

	it("refuses with no token, with a wrong token, and with the token only in the query string — never 200", async () => {
		const { port, bootstrap } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: Buffer.from("hi"),
		});
		const base = { Host: `127.0.0.1:${port}` };

		const noToken = await fetch(assetUrl(port, "asset-1"), { headers: base });
		expect(noToken.status).not.toBe(200);

		const wrongToken = await fetch(assetUrl(port, "asset-1"), {
			headers: {
				...base,
				"X-Dg-Session-Id": bootstrap.sessionId,
				"X-Dg-Session-Token": "not-the-real-token",
			},
		});
		expect(wrongToken.status).not.toBe(200);

		// Token in the query string only, no header at all — must not authenticate.
		const queryOnly = await fetch(
			`${assetUrl(port, "asset-1")}?sessionId=${bootstrap.sessionId}&token=${bootstrap.token}`,
			{ headers: base },
		);
		expect(queryOnly.status).not.toBe(200);
	});

	it("refuses another session's own valid credential — it authenticates as itself but the asset isn't its own", async () => {
		const { port, bootstrap } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: Buffer.from("hi"),
		});
		const spawned = JSON.parse(
			(
				await runCli(dgHome, port, ["spawn", "--session", bootstrap.sessionId])
			).stdout.trim(),
		) as { sessionId: string; token: string };

		const resp = await fetch(assetUrl(port, "asset-1"), {
			headers: {
				Host: `127.0.0.1:${port}`,
				"X-Dg-Session-Id": spawned.sessionId,
				"X-Dg-Session-Token": spawned.token,
			},
		});
		expect(resp.status).not.toBe(200);
	});

	it("never serves an SVG or HTML asset inline, and always carries the nosniff header, including on refusals", async () => {
		const { port, bootstrap } = await bootWithAsset({
			id: "asset-svg",
			filename: "logo.svg",
			contentType: "image/svg+xml",
			bytes: Buffer.from("<svg onload=alert(1)></svg>"),
		});
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const store = await ChatStore.open(paths, {
			env: { DG_KEY_SOURCE: "file" },
		});
		await registerAsset(
			{ paths, store },
			{
				sessionId: bootstrap.sessionId,
				id: "asset-html",
				filename: "page.html",
				contentType: "text/html",
				bytes: Buffer.from("<script>alert(1)</script>"),
			},
		);
		store.close();

		const authedHeaders = {
			Host: `127.0.0.1:${port}`,
			"X-Dg-Session-Id": bootstrap.sessionId,
			"X-Dg-Session-Token": bootstrap.token,
		};

		const svgResp = await fetch(assetUrl(port, "asset-svg"), {
			headers: authedHeaders,
		});
		expect(svgResp.headers.get("x-content-type-options")).toBe("nosniff");
		expect(svgResp.headers.get("content-disposition") ?? "").toMatch(
			/attachment/i,
		);

		const htmlResp = await fetch(assetUrl(port, "asset-html"), {
			headers: authedHeaders,
		});
		expect(htmlResp.headers.get("x-content-type-options")).toBe("nosniff");
		expect(htmlResp.headers.get("content-disposition") ?? "").toMatch(
			/attachment/i,
		);

		// Even a refusal carries nosniff — "every response", not just the successes.
		const refused = await fetch(assetUrl(port, "unknown-id"), {
			headers: authedHeaders,
		});
		expect(refused.status).not.toBe(200);
		expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("distinguishes an unknown id from a pruned one in the response body, not just by identical 404 status", async () => {
		const { port, bootstrap } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: Buffer.from("hi"),
		});
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const store = await ChatStore.open(paths, {
			env: { DG_KEY_SOURCE: "file" },
		});
		store.pruneSessionAssets(bootstrap.sessionId);
		store.close();

		const authedHeaders = {
			Host: `127.0.0.1:${port}`,
			"X-Dg-Session-Id": bootstrap.sessionId,
			"X-Dg-Session-Token": bootstrap.token,
		};

		const prunedResp = await fetch(assetUrl(port, "asset-1"), {
			headers: authedHeaders,
		});
		const unknownResp = await fetch(assetUrl(port, "never-existed"), {
			headers: authedHeaders,
		});

		expect(prunedResp.status).not.toBe(200);
		expect(unknownResp.status).not.toBe(200);
		const [prunedBody, unknownBody] = await Promise.all([
			prunedResp.text(),
			unknownResp.text(),
		]);
		expect(prunedBody).not.toBe(unknownBody);
	});
});
