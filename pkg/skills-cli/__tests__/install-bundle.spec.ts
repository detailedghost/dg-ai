import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fetchBundle } from "../src/install/bundle";
import {
	buildArchive,
	type FetchStub,
	fakeBunScript,
	scratch,
	sha256,
	stubFetch,
	type Scratch,
} from "./runtime-bundle-fixtures";

const VERSION = "1.27.0";
const PREVIOUS = "1.26.1";
const OLDER = "1.25.0";
const ASSET = `dg-lib-${VERSION}.tar.gz`;
const URL = `https://example.test/releases/v${VERSION}/${ASSET}`;
const SUMS_URL = `https://example.test/releases/v${VERSION}/SHA256SUMS`;

let sandbox: Scratch;
let fetchStub: FetchStub | undefined;

beforeEach(() => {
	sandbox = scratch("fetch-bundle");
});

afterEach(() => {
	fetchStub?.restore();
	fetchStub = undefined;
	sandbox.cleanup();
});

function seedVersion(version: string): void {
	const dir = join(sandbox.root, "lib", version);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "dg.js"), `console.log("${version}");\n`);
}

function seedCurrent(version: string): void {
	symlinkSync(version, join(sandbox.root, "lib", "current"));
}

function serve(sumsHash?: string): void {
	const tarball = buildArchive("tar.gz", sandbox.directory, {
		"dg.js": { content: `console.log("${VERSION}");\n` },
		"chunks/skills-main.js": { content: "export {};\n" },
	});
	fetchStub = stubFetch({
		[URL]: tarball,
		[SUMS_URL]: `${sumsHash ?? sha256(tarball)}  ${ASSET}\n`,
	});
}

function release() {
	return { version: VERSION, assetName: ASSET, url: URL, sumsUrl: SUMS_URL };
}

function runtimeBinThatExits(code: number): string {
	const path = join(sandbox.directory, `runtime-exit-${code}`);
	writeFileSync(path, fakeBunScript("self-check output", code), { mode: 0o755 });
	return path;
}

describe("fetchBundle", () => {
	test("leaves lib/current on the old version and removes staging when the self-check exits non-zero", async () => {
		seedVersion(PREVIOUS);
		seedCurrent(PREVIOUS);
		serve();

		await expect(fetchBundle(sandbox.root, release(), runtimeBinThatExits(3))).rejects.toThrow();

		const lib = join(sandbox.root, "lib");
		expect(basename(readlinkSync(join(lib, "current")))).toBe(PREVIOUS);
		expect(existsSync(join(lib, `${VERSION}.staging`))).toBe(false);
		expect(existsSync(join(lib, VERSION))).toBe(false);
	});

	test("leaves lib/current on the old version when the self-check exits 0 but prints another version", async () => {
		seedVersion(PREVIOUS);
		seedCurrent(PREVIOUS);
		serve();
		const runtime = join(sandbox.directory, "runtime-wrong-version");
		writeFileSync(runtime, fakeBunScript(PREVIOUS), { mode: 0o755 });

		await expect(fetchBundle(sandbox.root, release(), runtime)).rejects.toThrow(`printed ${PREVIOUS}`);

		const lib = join(sandbox.root, "lib");
		expect(basename(readlinkSync(join(lib, "current")))).toBe(PREVIOUS);
		expect(existsSync(join(lib, `${VERSION}.staging`))).toBe(false);
		expect(existsSync(join(lib, VERSION))).toBe(false);
	});

	test("rejects a tarball whose sha256 is not the one SHA256SUMS lists and changes nothing", async () => {
		seedVersion(PREVIOUS);
		seedCurrent(PREVIOUS);
		serve("0".repeat(64));

		await expect(fetchBundle(sandbox.root, release(), process.execPath)).rejects.toThrow();

		const lib = join(sandbox.root, "lib");
		expect(basename(readlinkSync(join(lib, "current")))).toBe(PREVIOUS);
		expect(existsSync(join(lib, VERSION))).toBe(false);
		expect(existsSync(join(lib, `${VERSION}.staging`))).toBe(false);
	});

	test("installs the verified bundle, relinks lib/current, keeps the previous version and removes older ones", async () => {
		seedVersion(OLDER);
		seedVersion(PREVIOUS);
		seedCurrent(PREVIOUS);
		serve();

		const final = await fetchBundle(sandbox.root, release(), process.execPath);

		const lib = join(sandbox.root, "lib");
		expect(final).toBe(join(lib, VERSION));
		expect(basename(readlinkSync(join(lib, "current")))).toBe(VERSION);
		expect(readFileSync(join(lib, "current", "dg.js"), "utf8")).toContain(VERSION);
		expect(existsSync(join(lib, PREVIOUS, "dg.js"))).toBe(true);
		expect(existsSync(join(lib, OLDER))).toBe(false);
		expect(existsSync(join(lib, `${VERSION}.staging`))).toBe(false);
	});
});
