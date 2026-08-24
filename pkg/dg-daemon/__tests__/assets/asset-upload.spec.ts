import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAT_MAX_ASSET_BYTES } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { ChatStore } from "../../src/store";
import { runCli } from "../commands/cli-wire";
import {
	BROWSER_ORIGIN,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	killDaemonByPidFile,
	scanFileForBytes,
	startWithSession,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

async function bootUploadSession() {
	const started = await startWithSession();
	dgHome = started.dgHome;
	return started;
}

function bufferBody(bytes: Buffer) {
	return new Uint8Array(
		bytes.buffer as ArrayBuffer,
		bytes.byteOffset,
		bytes.byteLength,
	);
}

function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
	const chunk = new Uint8Array(64 * 1024).fill(1);
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			if (sent >= totalBytes) {
				controller.close();
				return;
			}
			const size = Math.min(chunk.byteLength, totalBytes - sent);
			controller.enqueue(chunk.subarray(0, size));
			sent += size;
		},
	});
}

function assetsUrl(port: number): string {
	return `http://127.0.0.1:${port}/assets`;
}

function assetGetUrl(port: number, id: string): string {
	return `http://127.0.0.1:${port}/assets/${encodeURIComponent(id)}`;
}

function authedUploadHeaders(
	port: number,
	credentials: { sessionId: string; token: string },
	filename: string,
): Record<string, string> {
	return {
		Host: `127.0.0.1:${port}`,
		"X-Dg-Session-Id": credentials.sessionId,
		"X-Dg-Session-Token": credentials.token,
		"X-Dg-Filename": encodeURIComponent(filename),
	};
}

async function postAsset(
	port: number,
	headers: Record<string, string>,
	bytes: Buffer,
): Promise<Response> {
	return fetch(assetsUrl(port), {
		method: "POST",
		headers,
		body: bufferBody(bytes),
	});
}

function authedGetHeaders(
	port: number,
	credentials: { sessionId: string; token: string },
): Record<string, string> {
	return {
		Host: `127.0.0.1:${port}`,
		"X-Dg-Session-Id": credentials.sessionId,
		"X-Dg-Session-Token": credentials.token,
	};
}

describe("POST /assets", () => {
	it("accepts a valid upload and a subsequent GET returns the exact bytes with a filename-derived content type", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

		const uploadResp = await postAsset(
			port,
			authedUploadHeaders(port, bootstrap, "picture.png"),
			bytes,
		);
		expect(uploadResp.status).toBe(200);
		expect(uploadResp.headers.get("x-content-type-options")).toBe("nosniff");
		const { assetId } = (await uploadResp.json()) as { assetId: string };
		expect(assetId.length).toBeGreaterThan(0);

		const getResp = await fetch(assetGetUrl(port, assetId), {
			headers: authedGetHeaders(port, bootstrap),
		});
		expect(getResp.status).toBe(200);
		expect(getResp.headers.get("content-type")).toBe("image/png");
		const got = Buffer.from(await getResp.arrayBuffer());
		expect(got.equals(bytes)).toBe(true);
	});

	it("derives the content type from the filename server-side, ignoring a misleading client Content-Type", async () => {
		const { port, bootstrap } = await bootUploadSession();

		const uploadResp = await fetch(assetsUrl(port), {
			method: "POST",
			headers: {
				...authedUploadHeaders(port, bootstrap, "safe.png"),
				"Content-Type": "text/html",
			},
			body: bufferBody(Buffer.from("PNG-ish")),
		});
		expect(uploadResp.status).toBe(200);
		const { assetId } = (await uploadResp.json()) as { assetId: string };

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const store = await ChatStore.open(paths, FILE_ONLY_SEAMS);
		const row = store.getAsset(bootstrap.sessionId, assetId);
		store.close();
		expect(row?.contentType).toBe("image/png");
	});

	it("answers 401 with no session headers, with a fabricated token, and with a valid token paired with the wrong session", async () => {
		const { port, bootstrap } = await bootUploadSession();

		const noHeaders = await fetch(assetsUrl(port), {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${port}`,
				"X-Dg-Filename": encodeURIComponent("picture.png"),
			},
			body: bufferBody(Buffer.from("hi")),
		});
		expect(noHeaders.status).toBe(401);

		const fabricated = await postAsset(
			port,
			{
				Host: `127.0.0.1:${port}`,
				"X-Dg-Session-Id": bootstrap.sessionId,
				"X-Dg-Session-Token": "not-the-real-token",
				"X-Dg-Filename": encodeURIComponent("picture.png"),
			},
			Buffer.from("hi"),
		);
		expect(fabricated.status).toBe(401);

		const spawned = JSON.parse(
			(
				await runCli(dgHome, port, ["spawn", "--session", bootstrap.sessionId])
			).stdout.trim(),
		) as { sessionId: string; token: string };
		const wrongPairing = await postAsset(
			port,
			{
				Host: `127.0.0.1:${port}`,
				"X-Dg-Session-Id": bootstrap.sessionId,
				"X-Dg-Session-Token": spawned.token,
				"X-Dg-Filename": encodeURIComponent("picture.png"),
			},
			Buffer.from("hi"),
		);
		expect(wrongPairing.status).toBe(401);
	});

	it("answers 400 for a browser Origin", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const resp = await fetch(assetsUrl(port), {
			method: "POST",
			headers: {
				...authedUploadHeaders(port, bootstrap, "picture.png"),
				Origin: BROWSER_ORIGIN,
			},
			body: bufferBody(Buffer.from("hi")),
		});
		expect(resp.status).toBe(400);
	});

	it("answers 400 for a non-loopback Host", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const resp = await fetch(assetsUrl(port), {
			method: "POST",
			headers: {
				...authedUploadHeaders(port, bootstrap, "picture.png"),
				Host: "evil.example:9999",
			},
			body: bufferBody(Buffer.from("hi")),
		});
		expect(resp.status).toBe(400);
	});

	it("answers 400 for a missing X-Dg-Filename header", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const resp = await fetch(assetsUrl(port), {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${port}`,
				"X-Dg-Session-Id": bootstrap.sessionId,
				"X-Dg-Session-Token": bootstrap.token,
			},
			body: bufferBody(Buffer.from("hi")),
		});
		expect(resp.status).toBe(400);
	});

	it("answers 400 for a filename containing a path separator", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const resp = await postAsset(
			port,
			authedUploadHeaders(port, bootstrap, "sub/inner.png"),
			Buffer.from("hi"),
		);
		expect(resp.status).toBe(400);
	});

	it("answers 413 for a body over CHAT_MAX_ASSET_BYTES", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const oversized = Buffer.alloc(CHAT_MAX_ASSET_BYTES + 1024, 1);
		const resp = await postAsset(
			port,
			authedUploadHeaders(port, bootstrap, "huge.bin"),
			oversized,
		);
		expect(resp.status).toBe(413);
	});

	it("answers 413 over the wire for an oversized body that declares its length", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const oversized = Buffer.alloc(CHAT_MAX_ASSET_BYTES + 1024, 1);

		const resp = await postAsset(
			port,
			authedUploadHeaders(port, bootstrap, "huge.bin"),
			oversized,
		);

		expect(resp.status).toBe(413);
	});

	it("answers 413 over the wire for an oversized body that never declares its length", async () => {
		const { port, bootstrap } = await bootUploadSession();

		const resp = await fetch(assetsUrl(port), {
			method: "POST",
			headers: authedUploadHeaders(port, bootstrap, "huge.bin"),
			body: streamOf(CHAT_MAX_ASSET_BYTES + 1024),
			duplex: "half",
		} as RequestInit);

		expect(resp.status).toBe(413);
	});

	it("reassembles a streamed body of undeclared length byte for byte", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const chunk = Buffer.alloc(64 * 1024, 7);

		const upload = await fetch(assetsUrl(port), {
			method: "POST",
			headers: authedUploadHeaders(port, bootstrap, "streamed.bin"),
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(bufferBody(chunk));
					controller.enqueue(bufferBody(chunk));
					controller.close();
				},
			}),
			duplex: "half",
		} as RequestInit);
		expect(upload.status).toBe(200);
		const { assetId } = (await upload.json()) as { assetId: string };

		const fetched = await fetch(assetGetUrl(port, assetId), {
			headers: authedUploadHeaders(port, bootstrap, "streamed.bin"),
		});
		const served = Buffer.from(await fetched.arrayBuffer());

		expect(served.byteLength).toBe(chunk.byteLength * 2);
		expect(served.equals(Buffer.concat([chunk, chunk]))).toBe(true);
	});

	it("keeps the uploaded plaintext out of daemon.db and its -wal sidecar", async () => {
		const { port, bootstrap } = await bootUploadSession();
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const needle = "NEEDLE-ASSET-UPLOAD-PAYLOAD-91a2f";

		const resp = await postAsset(
			port,
			authedUploadHeaders(port, bootstrap, "note.txt"),
			Buffer.from(needle, "utf8"),
		);
		expect(resp.status).toBe(200);

		expect(scanFileForBytes(paths.dbPath, needle)).toBe(false);
		expect(scanFileForBytes(`${paths.dbPath}-wal`, needle)).toBe(false);
	});
});

describe("dg-daemon commands module no longer opens the store directly", () => {
	it("commands/index.ts contains no reference to ChatStore", () => {
		const source = readFileSync(
			join(import.meta.dir, "../../src/commands/index.ts"),
			"utf8",
		);
		expect(source).not.toContain("ChatStore");
	});
});
