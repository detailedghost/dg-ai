import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type CompanionModules,
	type CompanionName,
	type CompanionOptions,
	companionAssetName,
	companionDir,
	loadCompanion as loadCompanionWith,
} from "@dg/common/node/companion";
import { type DgPaths, resolveDgPaths } from "@dg/common/node/dg-paths";
import { expectedSha256, REPO, sha256Hex, UA } from "../utils/lib";

const MAX_COMPANION_BYTES = 128 * 1024 * 1024;
const MAX_SUMS_BYTES = 1024 * 1024;

export interface CompanionDeps {
	fetch?: typeof fetch;
	paths?: Pick<DgPaths, "dataDir">;
}

async function download(fetcher: typeof fetch, url: string, limit: number): Promise<Uint8Array> {
	const res = await fetcher(url, { headers: UA });
	if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.length > limit) throw new Error(`${url} is larger than ${limit} bytes`);
	return bytes;
}

async function unpackIndex(archive: Uint8Array, assetName: string): Promise<Uint8Array> {
	const files = await new Bun.Archive(Bun.zstdDecompressSync(archive)).files();
	const names = [...files.keys()];
	const index = files.get("index.js");
	if (names.length !== 1 || !index) throw new Error(`${assetName} must hold only index.js, found ${names.join(", ") || "nothing"}`);
	return new Uint8Array(await index.arrayBuffer());
}

function failure(name: CompanionName, version: string, dir: string, reason: unknown): Error {
	const asset = companionAssetName(name, version);
	const url = `https://github.com/${REPO}/releases/download/v${version}/${asset}`;
	const detail = reason instanceof Error ? reason.message : String(reason);
	return new Error(
		`The ${name} companion ${version} could not be downloaded: ${detail}\n` +
			`Run the command again to retry, or install it by hand: mkdir -p "${dir}" && curl -fsSL ${url} | zstd -dc | tar -x -C "${dir}"`,
	);
}

/** Downloads, verifies and unpacks a companion from the dg release; returns its directory. Unverified bytes are never written. */
export async function ensureCompanion(name: CompanionName, version: string, deps: CompanionDeps = {}): Promise<string> {
	const paths = deps.paths ?? resolveDgPaths();
	const dest = companionDir(paths, name, version);
	if (existsSync(join(dest, "index.js"))) return dest;
	const fetcher = deps.fetch ?? fetch;
	const asset = companionAssetName(name, version);
	const base = `https://github.com/${REPO}/releases/download/v${version}`;
	try {
		const archive = await download(fetcher, `${base}/${asset}`, MAX_COMPANION_BYTES);
		const sums = new TextDecoder().decode(await download(fetcher, `${base}/SHA256SUMS`, MAX_SUMS_BYTES));
		const expected = expectedSha256(sums, asset);
		if (!expected) throw new Error(`SHA256SUMS in v${version} has no entry for ${asset}`);
		if (sha256Hex(archive) !== expected) throw new Error(`checksum mismatch for ${asset} in v${version}`);
		const index = await unpackIndex(archive, asset);
		const root = dirname(dest);
		mkdirSync(root, { recursive: true });
		const staging = mkdtempSync(join(root, `.${name}-${version}.staging-`));
		try {
			writeFileSync(join(staging, "index.js"), index);
			rmSync(dest, { recursive: true, force: true });
			renameSync(staging, dest);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	} catch (err) {
		if (existsSync(join(dest, "index.js"))) return dest;
		throw failure(name, version, dest, err);
	}
	return dest;
}

/** Loads a companion, downloading it from the release on first use in a compiled build. */
export const loadCompanion = <N extends CompanionName>(name: N, options: CompanionOptions = {}): Promise<CompanionModules[N]> =>
	loadCompanionWith(name, { install: (n, v) => ensureCompanion(n, v, { paths: options.paths }), ...options });
