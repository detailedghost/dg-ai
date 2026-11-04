import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, normalize, sep } from "node:path";
import { narrationZipName } from "@dg/common";
import { ensurePrivateDir, resolveDgPaths } from "@dg/common/node";
import { expectedSha256, extractZip, REPO } from "../utils/lib";

export type AssetDeps = { fetch?: typeof fetch };

const REQUIRED = [
	"kokoro.js",
	"ort/ort-wasm-simd-threaded.jsep.mjs",
	"ort/ort-wasm-simd-threaded.jsep.wasm",
];

const CONTENT_TYPES: Record<string, string> = {
	".js": "text/javascript",
	".mjs": "text/javascript",
	".wasm": "application/wasm",
};

const narrationRoot = (): string =>
	join(resolveDgPaths().dataDir, "demo-narration");

const complete = (dir: string): boolean =>
	REQUIRED.every((file) => existsSync(join(dir, file)));

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

const isTimeout = (error: unknown): boolean =>
	error instanceof Error &&
	(error.name === "TimeoutError" || error.name === "AbortError");

export const isNetworkFailure = (error: unknown): boolean =>
	error instanceof TypeError ||
	(error instanceof Error && error.message.startsWith("download failed"));

async function download(
	fetcher: typeof fetch,
	url: string,
	maxBytes: number,
): Promise<Uint8Array> {
	try {
		return await downloadBody(fetcher, url, maxBytes);
	} catch (error) {
		if (isTimeout(error))
			throw new Error(
				`download of ${url} timed out after ${DOWNLOAD_TIMEOUT_MS / 1000} seconds`,
			);
		throw error;
	}
}

async function downloadBody(
	fetcher: typeof fetch,
	url: string,
	maxBytes: number,
): Promise<Uint8Array> {
	const res = await fetcher(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`download failed for ${url}: HTTP ${res.status}`);
	const tooLarge = () => new Error(`download of ${url} is larger than ${maxBytes} bytes`);
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
	const chunks: Uint8Array[] = [];
	let received = 0;
	if (res.body) {
		const reader = res.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.length;
			if (received > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw tooLarge();
			}
			chunks.push(value);
		}
	}
	return Buffer.concat(chunks);
}

function assertPlainEntries(root: string): void {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) assertPlainEntries(path);
		else if (!stat.isFile())
			throw new Error(`narration zip entry is not a regular file: ${entry.name}`);
	}
}

/** Fetch, verify and unpack the narration zip for `version`; a verified cache needs no network. */
export async function ensureNarrationAssets(
	version: string,
	deps: AssetDeps = {},
): Promise<string> {
	const dest = join(narrationRoot(), version);
	if (complete(dest)) return dest;
	const fetcher = deps.fetch ?? fetch;
	const name = narrationZipName(version);
	const base = `https://github.com/${REPO}/releases/download/v${version}`;
	const zip = await download(fetcher, `${base}/${name}`, MAX_DOWNLOAD_BYTES);
	const sums = new TextDecoder().decode(
		await download(fetcher, `${base}/SHA256SUMS`, 1024 * 1024),
	);
	const expected = expectedSha256(sums, name);
	if (!expected) throw new Error(`SHA256SUMS has no entry for ${name}`);
	const actual = new Bun.CryptoHasher("sha256").update(zip).digest("hex");
	if (actual !== expected) throw new Error(`checksum mismatch for ${name}`);

	ensurePrivateDir(narrationRoot());
	const work = mkdtempSync(join(narrationRoot(), ".download-"));
	try {
		const file = join(work, name);
		writeFileSync(file, zip, { mode: 0o600 });
		const staged = join(work, "unpacked");
		extractZip(file, staged);
		assertPlainEntries(staged);
		if (!complete(staged))
			throw new Error(`${name} is missing required narration files`);
		rmSync(dest, { recursive: true, force: true });
		mkdirSync(narrationRoot(), { recursive: true });
		renameSync(staged, dest);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
	return dest;
}

export type AssetResponse = {
	status: number;
	headers: Record<string, string>;
	body: Buffer;
};

const notFound = (): AssetResponse => ({
	status: 404,
	headers: { "access-control-allow-origin": "*" },
	body: Buffer.alloc(0),
});

const cache = new Map<string, Buffer>();

/** Maps a request path under /narration/ onto a file in `dir`; anything outside it is a 404. */
export function serveNarrationAsset(dir: string, pathname: string): AssetResponse {
	const prefix = "/narration/";
	if (!pathname.startsWith(prefix)) return notFound();
	let relative: string;
	try {
		relative = normalize(decodeURIComponent(pathname.slice(prefix.length)));
	} catch {
		return notFound();
	}
	const type = CONTENT_TYPES[relative.slice(relative.lastIndexOf("."))];
	if (!type || relative.startsWith("..") || relative.includes(`..${sep}`))
		return notFound();
	const file = join(dir, relative);
	if (!existsSync(file)) return notFound();
	try {
		if (!lstatSync(file).isFile()) return notFound();
		const root = realpathSync(dir);
		if (!realpathSync(file).startsWith(root + sep)) return notFound();
	} catch {
		return notFound();
	}
	let body = cache.get(file);
	if (!body) {
		body = readFileSync(file);
		cache.set(file, body);
	}
	return {
		status: 200,
		headers: {
			"content-type": type,
			"access-control-allow-origin": "*",
			"cache-control": "private, max-age=3600",
		},
		body,
	};
}
