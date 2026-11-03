import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureRuntime, runtimeAssetKey } from "../src/install/runtime";
import {
	buildArchive,
	bunZipUrl,
	fakeBunScript,
	runtimePinFor,
	type FetchStub,
	scratch,
	sha256,
	stubFetch,
	type Scratch,
} from "./runtime-bundle-fixtures";

const BUN = process.platform === "win32" ? "bun.exe" : "bun";

let sandbox: Scratch;
let fetchStub: FetchStub | undefined;

beforeEach(() => {
	sandbox = scratch("ensure-runtime");
});

afterEach(() => {
	fetchStub?.restore();
	fetchStub = undefined;
	sandbox.cleanup();
});

describe("ensureRuntime", () => {
	test("downloads nothing and returns the existing path when the pinned version is installed", async () => {
		const pin = runtimePinFor("unused");
		const versionDir = join(sandbox.root, "runtime", `bun-v${pin.version}`);
		mkdirSync(versionDir, { recursive: true });
		writeFileSync(join(versionDir, BUN), fakeBunScript(pin.version), { mode: 0o755 });
		symlinkSync(versionDir, join(sandbox.root, "runtime", "current"));
		fetchStub = stubFetch({});

		const path = await ensureRuntime(sandbox.root, pin);

		expect(fetchStub.calls).toEqual([]);
		expect(realpathSync(path)).toBe(realpathSync(join(versionDir, BUN)));
	});

	test("rejects a zip whose sha256 differs from runtime.json and leaves runtime/current untouched", async () => {
		const zip = buildArchive("zip", sandbox.directory, {
			"bun-fake/bun": { content: fakeBunScript("1.4.1"), mode: 0o755 },
		});
		const pin = runtimePinFor("a different zip than the one served");
		expect(pin.assets["linux-x64"].sha256).not.toBe(sha256(zip));
		const oldDir = join(sandbox.root, "runtime", "bun-v0.0.1");
		mkdirSync(oldDir, { recursive: true });
		writeFileSync(join(oldDir, BUN), fakeBunScript("0.0.1"), { mode: 0o755 });
		const current = join(sandbox.root, "runtime", "current");
		symlinkSync(oldDir, current);
		fetchStub = stubFetch({ [bunZipUrl(pin.version)]: zip });

		await expect(ensureRuntime(sandbox.root, pin)).rejects.toThrow();

		expect(fetchStub.calls).toEqual([bunZipUrl(pin.version)]);
		expect(basename(readlinkSync(current))).toBe("bun-v0.0.1");
		expect(existsSync(join(sandbox.root, "runtime", `bun-v${pin.version}`, BUN))).toBe(false);
	});

	test("installs the verified zip under runtime/bun-v<version> and links runtime/current to it", async () => {
		const zip = buildArchive("zip", sandbox.directory, {
			"bun-fake/bun": { content: fakeBunScript("1.4.1"), mode: 0o755 },
		});
		const pin = runtimePinFor(zip);
		fetchStub = stubFetch({ [bunZipUrl(pin.version)]: zip });

		const path = await ensureRuntime(sandbox.root, pin);

		const current = join(sandbox.root, "runtime", "current");
		expect(basename(readlinkSync(current))).toBe(`bun-v${pin.version}`);
		expect(existsSync(join(current, BUN))).toBe(true);
		expect(realpathSync(path)).toBe(realpathSync(join(current, BUN)));
	});
});

describe("ensureRuntime with concurrent installers", () => {
	function zipFor(version: string): Uint8Array {
		return buildArchive("zip", sandbox.directory, {
			"bun-fake/bun": { content: fakeBunScript(version), mode: 0o755 },
		});
	}

	test("keeps a finalDir that another installer published while this one was downloading", async () => {
		const zip = zipFor("1.4.1");
		const pin = runtimePinFor(zip);
		fetchStub = stubFetch({ [bunZipUrl(pin.version)]: zip });
		const finalDir = join(sandbox.root, "runtime", `bun-v${pin.version}`);
		const stubbed = globalThis.fetch;
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			const res = await stubbed(input as string, init);
			mkdirSync(finalDir, { recursive: true });
			writeFileSync(join(finalDir, BUN), fakeBunScript("other"), { mode: 0o755 });
			writeFileSync(join(finalDir, "marker"), "published by the other installer");
			return res;
		}) as typeof fetch;

		await ensureRuntime(sandbox.root, pin);

		expect(readFileSync(join(finalDir, "marker"), "utf8")).toBe("published by the other installer");
		expect(basename(readlinkSync(join(sandbox.root, "runtime", "current")))).toBe(`bun-v${pin.version}`);
		expect(readdirSync(join(sandbox.root, "runtime")).sort()).toEqual([`bun-v${pin.version}`, "current"]);
	});

	test("two simultaneous installs of one pin both succeed and leave no staging directories", async () => {
		const zip = zipFor("1.4.1");
		const pin = runtimePinFor(zip);
		fetchStub = stubFetch({ [bunZipUrl(pin.version)]: zip });

		const [first, second] = await Promise.all([
			ensureRuntime(sandbox.root, pin),
			ensureRuntime(sandbox.root, pin),
		]);

		expect(first).toBe(second);
		expect(existsSync(first)).toBe(true);
		expect(readdirSync(join(sandbox.root, "runtime")).sort()).toEqual([`bun-v${pin.version}`, "current"]);
	});
});

const AVX2 = "flags\t\t: fpu vme sse4_2 avx avx2 bmi2\n";
const NO_AVX2 = "flags\t\t: fpu vme sse4_2 avx\n";

describe("runtimeAssetKey", () => {
	function cpuinfo(content: string): string {
		const file = join(sandbox.directory, "cpuinfo");
		writeFileSync(file, content);
		return file;
	}

	test("picks the baseline build on linux-x64 when cpuinfo lacks avx2", () => {
		expect(runtimeAssetKey("linux", "x64", cpuinfo(NO_AVX2))).toBe("linux-x64-baseline");
	});

	test("picks the regular build on linux-x64 when cpuinfo lists avx2 or cannot be read", () => {
		expect(runtimeAssetKey("linux", "x64", cpuinfo(AVX2))).toBe("linux-x64");
		expect(runtimeAssetKey("linux", "x64", join(sandbox.directory, "missing"))).toBe("linux-x64");
	});

	test("ignores cpuinfo on other platforms and maps win32 to windows", () => {
		expect(runtimeAssetKey("linux", "arm64", cpuinfo(NO_AVX2))).toBe("linux-arm64");
		expect(runtimeAssetKey("darwin", "arm64", cpuinfo(NO_AVX2))).toBe("darwin-arm64");
		expect(runtimeAssetKey("win32", "x64", cpuinfo(NO_AVX2))).toBe("windows-x64");
	});
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("ensureRuntime on linux-x64", () => {
	test("downloads the baseline zip when DG_CPUINFO_FILE lacks avx2", async () => {
		const zip = buildArchive("zip", sandbox.directory, {
			"bun-linux-x64-baseline/bun": { content: fakeBunScript("1.4.1"), mode: 0o755 },
		});
		const pin = {
			version: "1.4.1",
			assets: {
				"linux-x64": { file: "bun-linux-x64.zip", sha256: "0".repeat(64) },
				"linux-x64-baseline": { file: "bun-linux-x64-baseline.zip", sha256: sha256(zip) },
			},
		};
		const cpuinfo = join(sandbox.directory, "cpuinfo");
		writeFileSync(cpuinfo, NO_AVX2);
		const baselineUrl = bunZipUrl(pin.version).replace("bun-fake.zip", "bun-linux-x64-baseline.zip");
		fetchStub = stubFetch({ [baselineUrl]: zip });
		const saved = process.env.DG_CPUINFO_FILE;
		process.env.DG_CPUINFO_FILE = cpuinfo;
		try {
			await ensureRuntime(sandbox.root, pin);
		} finally {
			if (saved === undefined) delete process.env.DG_CPUINFO_FILE;
			else process.env.DG_CPUINFO_FILE = saved;
		}

		expect(fetchStub.calls).toEqual([baselineUrl]);
		expect(existsSync(join(sandbox.root, "runtime", "current", BUN))).toBe(true);
	});
});
