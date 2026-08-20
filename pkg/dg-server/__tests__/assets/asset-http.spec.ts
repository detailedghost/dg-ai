/**
 * GET /assets/:id — the daemon half of the wire contract chat-transcript.ts's
 * defaultFetchAsset already calls verbatim (that route, those header names).
 * Rows are written by opening a second ChatStore against the SAME DG_HOME the
 * running daemon uses; WAL supports the extra writer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, ftruncateSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { CHAT_MAX_ASSET_BYTES, validateSessionBootstrap } from "@dg/common";
import { type DgPaths, resolveDgPaths } from "@dg/common/node";
import { getConfiguredAssetDirectory } from "../../src/assets/config";
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

const SECOND_OPENER_SEAMS = {
	env: { DG_KEY_SOURCE: "file" },
};

function openSecondStore(paths: DgPaths): Promise<ChatStore> {
	return ChatStore.open(paths, SECOND_OPENER_SEAMS);
}

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
	const store = await openSecondStore(paths);
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

function authedHeaders(
	port: number,
	credentials: { sessionId: string; token: string },
) {
	return {
		Host: `127.0.0.1:${port}`,
		"X-Dg-Session-Id": credentials.sessionId,
		"X-Dg-Session-Token": credentials.token,
	};
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
			headers: authedHeaders(port, bootstrap),
		});

		expect(resp.status).toBe(200);
		expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
		expect(resp.headers.get("content-disposition")).toBe("inline");
		const body = Buffer.from(await resp.arrayBuffer());
		expect(body.equals(png)).toBe(true);
	});

	it("answers 401 with no token, with a wrong token, and with the token only in the query string", async () => {
		const { port, bootstrap } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: Buffer.from("hi"),
		});
		const base = { Host: `127.0.0.1:${port}` };

		const noToken = await fetch(assetUrl(port, "asset-1"), { headers: base });
		expect(noToken.status).toBe(401);

		const wrongToken = await fetch(assetUrl(port, "asset-1"), {
			headers: {
				...base,
				"X-Dg-Session-Id": bootstrap.sessionId,
				"X-Dg-Session-Token": "not-the-real-token",
			},
		});
		expect(wrongToken.status).toBe(401);

		// Token in the query string only, no header at all — must not authenticate.
		const queryOnly = await fetch(
			`${assetUrl(port, "asset-1")}?sessionId=${bootstrap.sessionId}&token=${bootstrap.token}`,
			{ headers: base },
		);
		expect(queryOnly.status).toBe(401);
	});

	it("answers a malformed percent-encoded id with a plain-text 400, never Bun's scripted error page", async () => {
		const { port, bootstrap } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: Buffer.from("hi"),
		});

		const resp = await fetch(`http://127.0.0.1:${port}/assets/%`, {
			headers: authedHeaders(port, bootstrap),
		});

		expect(resp.status).toBe(400);
		expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
		expect(resp.headers.get("content-type") ?? "").not.toMatch(/html/i);
		expect(await resp.text()).not.toMatch(/<script/i);
	});

	it("answers an unauthenticated malformed id with 401 and no page body either — the credential check runs first", async () => {
		const { port } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: Buffer.from("hi"),
		});

		const resp = await fetch(`http://127.0.0.1:${port}/assets/%`, {
			headers: { Host: `127.0.0.1:${port}` },
		});

		expect(resp.status).toBe(401);
		expect(resp.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await resp.text()).not.toMatch(/<script/i);
	});

	it("answers 404 for another session's own valid credential — it authenticates as itself but the asset isn't its own", async () => {
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
			headers: authedHeaders(port, spawned),
		});
		expect(resp.status).toBe(404);
		expect(await resp.text()).toContain("unknown");
	});

	it("never serves an SVG or HTML asset inline, and always carries the nosniff header, including on refusals", async () => {
		const { port, bootstrap, paths } = await bootWithAsset({
			id: "asset-svg",
			filename: "logo.svg",
			contentType: "image/svg+xml",
			bytes: Buffer.from("<svg onload=alert(1)></svg>"),
		});
		const store = await openSecondStore(paths);
		await registerAsset(
			{ paths, store },
			{
				sessionId: bootstrap.sessionId,
				id: "asset-html",
				filename: "page.html",
				contentType: "image/png",
				bytes: Buffer.from("<script>alert(1)</script>"),
			},
		);
		store.close();
		const headers = authedHeaders(port, bootstrap);

		const svgResp = await fetch(assetUrl(port, "asset-svg"), { headers });
		expect(svgResp.headers.get("x-content-type-options")).toBe("nosniff");
		expect(svgResp.headers.get("content-disposition") ?? "").toMatch(
			/attachment/i,
		);

		const htmlResp = await fetch(assetUrl(port, "asset-html"), { headers });
		expect(htmlResp.headers.get("content-type")).toBe("text/html");
		expect(htmlResp.headers.get("x-content-type-options")).toBe("nosniff");
		expect(htmlResp.headers.get("content-disposition") ?? "").toMatch(
			/attachment/i,
		);

		// Even a refusal carries nosniff — "every response", not just the successes.
		const refused = await fetch(assetUrl(port, "unknown-id"), { headers });
		expect(refused.status).toBe(404);
		expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("distinguishes an unknown id from one pruned by a real session close, in the body not just the status", async () => {
		const { port, bootstrap } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: Buffer.from("hi"),
		});
		const headers = authedHeaders(port, bootstrap);

		const closed = await runCli(dgHome, port, [
			"close",
			"--session",
			bootstrap.sessionId,
		]);
		expect(closed.exitCode).toBe(0);

		const prunedResp = await fetch(assetUrl(port, "asset-1"), { headers });
		const unknownResp = await fetch(assetUrl(port, "never-existed"), {
			headers,
		});

		expect(prunedResp.status).toBe(404);
		expect(unknownResp.status).toBe(404);
		const [prunedBody, unknownBody] = await Promise.all([
			prunedResp.text(),
			unknownResp.text(),
		]);
		expect(prunedBody).toContain("pruned");
		expect(unknownBody).toContain("unknown");
	});

	it("refuses an oversized staged file with its own reason rather than a generic path refusal", async () => {
		const { port, bootstrap, paths } = await bootWithAsset({
			id: "asset-1",
			filename: "picture.png",
			contentType: "image/png",
			bytes: Buffer.from("hi"),
		});
		const store = await openSecondStore(paths);
		store.insertAsset({
			sessionId: bootstrap.sessionId,
			id: "asset-huge",
			filename: "huge.png",
			contentType: "image/png",
			byteLength: 1,
		});
		store.close();
		const sessionDir = join(
			getConfiguredAssetDirectory(paths),
			bootstrap.sessionId,
		);
		mkdirSync(sessionDir, { recursive: true });
		const fd = openSync(join(sessionDir, "asset-huge"), "w");
		ftruncateSync(fd, CHAT_MAX_ASSET_BYTES * 4);
		closeSync(fd);

		const resp = await fetch(assetUrl(port, "asset-huge"), {
			headers: authedHeaders(port, bootstrap),
		});
		expect(resp.status).toBe(500);
		expect(await resp.text()).toContain("maximum size");
	});
});
