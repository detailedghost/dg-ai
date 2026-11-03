import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const RUNTIME_JSON = join(import.meta.dir, "..", "..", "launcher", "runtime.json");

export interface FileSpec {
	content: string;
	mode?: number;
}

export interface Scratch {
	directory: string;
	root: string;
	cleanup(): void;
}

export function scratch(prefix: string): Scratch {
	const directory = mkdtempSync(join(tmpdir(), `dg-${prefix}-`));
	const root = join(directory, "root");
	mkdirSync(root, { recursive: true });
	return { directory, root, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

export function sha256(buf: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

export function writeTree(dir: string, files: Record<string, FileSpec>): void {
	for (const [name, spec] of Object.entries(files)) {
		const path = join(dir, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, spec.content);
		chmodSync(path, spec.mode ?? 0o644);
	}
}

export function buildArchive(
	kind: "tar.gz" | "zip",
	workDir: string,
	files: Record<string, FileSpec>,
): Uint8Array {
	const source = join(workDir, `src-${kind}-${Math.random().toString(36).slice(2)}`);
	const out = join(workDir, `archive-${Math.random().toString(36).slice(2)}.${kind}`);
	writeTree(source, files);
	const entries = [...new Set(Object.keys(files).map((name) => name.split("/")[0]))];
	const argv =
		kind === "zip"
			? ["zip", "-qr", out, ...entries]
			: ["tar", "-czf", out, "-C", source, ...entries];
	const proc = Bun.spawnSync(argv, { cwd: source, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`${argv[0]} failed: ${proc.stderr.toString()}`);
	return new Uint8Array(readFileSync(out));
}

export interface FetchStub {
	calls: string[];
	restore(): void;
}

export function stubFetch(routes: Record<string, Uint8Array | string>): FetchStub {
	const original = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: unknown) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push(url);
		const body = routes[url];
		if (body === undefined) return new Response("not found", { status: 404 });
		return new Response(typeof body === "string" ? body : Buffer.from(body));
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

export function runtimePinFor(zip: Uint8Array | string, version = "1.4.1") {
	const real = JSON.parse(readFileSync(RUNTIME_JSON, "utf8")) as {
		assets: Record<string, { file: string; sha256: string }>;
	};
	const assets = Object.fromEntries(
		Object.keys(real.assets).map((key) => [key, { file: "bun-fake.zip", sha256: sha256(zip) }]),
	);
	return { version, assets };
}

export function bunZipUrl(version: string): string {
	return `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-fake.zip`;
}

export function fakeBunScript(output: string, exitCode = 0): string {
	return `#!/bin/sh\necho "${output}"\nexit ${exitCode}\n`;
}

export const RELEASE_BASE = "https://github.com/detailedghost/dg-ai/releases/download";

export type ReleaseKind = "bundle" | "extension" | "runtime" | "sums";

export interface ReleaseServerOptions {
	also?: string[];
	omit?: ReleaseKind[];
	absent?: boolean;
	sums?: (defaults: string) => string;
}

export function writeReleaseServer(
	dir: string,
	log: string,
	version: string,
	opts: ReleaseServerOptions = {},
): { preload: string; pin: string } {
	const bunZip = buildArchive("zip", dir, {
		"bun-fake/bun": { content: fakeBunScript(version), mode: 0o755 },
	});
	const runtimeJson = JSON.stringify(runtimePinFor(bunZip));
	const routes: Record<string, string> = {};
	const serveFile = (url: string, name: string, body: Uint8Array | string): void => {
		const path = join(dir, `served-${name}`);
		writeFileSync(path, body);
		routes[url] = path;
	};
	const releases: { tag_name: string; draft: boolean; assets: { name: string; browser_download_url: string }[] }[] = [];
	for (const current of [version, ...(opts.also ?? [])]) {
		if (current === version && opts.absent) continue;
		const tag = `v${current}`;
		const bundleName = `dg-lib-${current}.tar.gz`;
		const extensionName = `dg-ai-extension-${current}-chrome.zip`;
		const bundle = buildArchive("tar.gz", dir, { "dg.js": { content: "console.log('unused');\n" } });
		const extension = buildArchive("zip", dir, {
			"manifest.json": { content: JSON.stringify({ version: current }) },
			"background.js": { content: "release build" },
		});
		const sums = [
			[bundleName, sha256(bundle)],
			[extensionName, sha256(extension)],
			["runtime.json", sha256(runtimeJson)],
		]
			.map(([name, hash]) => `${hash}  ${name}`)
			.join("\n");
		const kinds: Record<ReleaseKind, [string, Uint8Array | string]> = {
			bundle: [bundleName, bundle],
			extension: [extensionName, extension],
			runtime: ["runtime.json", runtimeJson],
			sums: ["SHA256SUMS", current === version && opts.sums ? opts.sums(sums) : sums],
		};
		const assets = (Object.keys(kinds) as ReleaseKind[])
			.filter((kind) => current !== version || !opts.omit?.includes(kind))
			.map((kind) => kinds[kind]);
		for (const [name, body] of assets) serveFile(`${RELEASE_BASE}/${tag}/${name}`, `${current}-${name}`, body);
		releases.push({
			tag_name: tag,
			draft: false,
			assets: assets.map(([name]) => ({ name, browser_download_url: `${RELEASE_BASE}/${tag}/${name}` })),
		});
	}
	serveFile(bunZipUrl(JSON.parse(runtimeJson).version), "bun.zip", bunZip);
	const preload = join(dir, "release-preload.ts");
	writeFileSync(
		preload,
		`import { appendFileSync, readFileSync } from "node:fs";
const routes = ${JSON.stringify(routes)};
const releases = ${JSON.stringify(releases)};
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  appendFileSync(${JSON.stringify(log)}, url + "\\n");
  if (url.includes("/releases?")) return new Response(JSON.stringify(releases));
  const file = routes[url];
  if (!file) return new Response("not found", { status: 404 });
  return new Response(readFileSync(file));
}) as typeof fetch;
`,
	);
	return { preload, pin: JSON.parse(runtimeJson).version };
}

export function fetchedUrls(log: string): string[] {
	return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

export function installEnv(home: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.DG_CLI_ONLY;
	delete env.DG_SKILLS_ONLY;
	env.HOME = home;
	env.DG_HOME = home;
	env.LC_ALL = "C";
	return env;
}

export async function runCli(
	argv: string[],
	env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}
