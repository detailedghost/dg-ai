import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDgPaths } from "@dg/common/node";
import { ensureNarrationAssets, isNetworkFailure } from "../src/demo/narration-assets";
import {
	FIXTURE_ENTRIES,
	narrationZipName,
	sha256,
	storedZip,
} from "./demo-narration-fixtures";

const VERSION = "9.9.9";
const WASM = "ort/ort-wasm-simd-threaded.jsep.wasm";

let home: string;
const previous = { HOME: process.env.HOME, DG_HOME: process.env.DG_HOME };

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dg-narration-assets-"));
	mkdirSync(join(home, "state"), { recursive: true });
	process.env.HOME = home;
	process.env.DG_HOME = join(home, "state");
});
afterEach(() => {
	for (const [key, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
});

const cacheDir = (): string =>
	join(resolveDgPaths().stateDir, "demo-narration", VERSION);

function releaseFetch(options: { zip: Uint8Array<ArrayBuffer>; listed?: Uint8Array<ArrayBuffer> }) {
	const name = narrationZipName(VERSION);
	const sums = `${sha256(options.listed ?? options.zip)}  ${name}\n`;
	const urls: string[] = [];
	const fetcher = (async (input: unknown) => {
		const url = String(input instanceof Request ? input.url : input);
		urls.push(url);
		if (url.endsWith("SHA256SUMS")) return new Response(sums);
		if (url.endsWith(name)) return new Response(new Blob([options.zip]));
		return new Response("missing", { status: 404 });
	}) as unknown as typeof fetch;
	return { fetcher, urls };
}

describe("ensureNarrationAssets", () => {
	test("downloads the zip, verifies the SHA256SUMS entry and unpacks it into the versioned cache", async () => {
		const zip = storedZip(FIXTURE_ENTRIES);
		const { fetcher, urls } = releaseFetch({ zip });
		await ensureNarrationAssets(VERSION, { fetch: fetcher });
		expect(urls.some((url) => url.endsWith(narrationZipName(VERSION)))).toBe(true);
		const wasm = FIXTURE_ENTRIES.find((entry) => entry.name === WASM);
		expect(new Uint8Array(readFileSync(join(cacheDir(), WASM)))).toEqual(
			new Uint8Array(wasm?.data ?? []),
		);
	});

	test("refuses a tampered zip with checksum mismatch and leaves nothing in the cache", async () => {
		const good = storedZip(FIXTURE_ENTRIES);
		const tampered = storedZip([
			...FIXTURE_ENTRIES,
			{ name: "evil.js", data: new TextEncoder().encode("steal()") },
		]);
		const { fetcher } = releaseFetch({ zip: tampered, listed: good });
		await expect(
			ensureNarrationAssets(VERSION, { fetch: fetcher }),
		).rejects.toThrow("checksum mismatch");
		expect(existsSync(join(cacheDir(), "evil.js"))).toBe(false);
		expect(existsSync(join(cacheDir(), WASM))).toBe(false);
	});

	test("serves a second call from the cache without touching the network", async () => {
		const { fetcher } = releaseFetch({ zip: storedZip(FIXTURE_ENTRIES) });
		await ensureNarrationAssets(VERSION, { fetch: fetcher });
		const offline = (async () => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		await ensureNarrationAssets(VERSION, { fetch: offline });
		expect(existsSync(join(cacheDir(), WASM))).toBe(true);
	});
	test("refuses a checksum-valid zip that contains a symlink entry", async () => {
		const zip = storedZip([
			...FIXTURE_ENTRIES,
			{ name: "link.js", data: new TextEncoder().encode("/etc/passwd"), unixMode: 0o120777 },
		]);
		const { fetcher } = releaseFetch({ zip });
		await expect(
			ensureNarrationAssets(VERSION, { fetch: fetcher }),
		).rejects.toThrow("not a regular file");
		expect(existsSync(cacheDir())).toBe(false);
	});

	test("refuses a checksum-valid zip that lacks a required narration file", async () => {
		const zip = storedZip(FIXTURE_ENTRIES.filter((entry) => entry.name !== WASM));
		const { fetcher } = releaseFetch({ zip });
		await expect(
			ensureNarrationAssets(VERSION, { fetch: fetcher }),
		).rejects.toThrow("missing required narration files");
		expect(existsSync(cacheDir())).toBe(false);
	});

	test("caps a streamed body that sends no content-length", async () => {
		const chunk = new Uint8Array(4 * 1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(chunk);
				sent += 1;
				if (sent > 32) controller.close();
			},
		});
		const fetcher = (async () => new Response(body)) as unknown as typeof fetch;
		await expect(
			ensureNarrationAssets(VERSION, { fetch: fetcher }),
		).rejects.toThrow(/larger than/);
		expect(sent).toBeLessThan(32);
	});
});

describe("ensureNarrationAssets download failures", () => {
	test("names a timeout instead of reporting a network failure", async () => {
		const timedOut = (async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}) as unknown as typeof fetch;
		const error = await ensureNarrationAssets(VERSION, { fetch: timedOut }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(Error);
		expect(isNetworkFailure(error)).toBe(false);
		expect((error as Error).message).toContain("timed out");
	});

	test("treats a rejected fetch and an HTTP error as network failures", () => {
		expect(isNetworkFailure(new TypeError("fetch failed"))).toBe(true);
		expect(isNetworkFailure(new Error("download failed for x: HTTP 503"))).toBe(true);
		expect(isNetworkFailure(new Error("checksum mismatch for x"))).toBe(false);
	});
});
