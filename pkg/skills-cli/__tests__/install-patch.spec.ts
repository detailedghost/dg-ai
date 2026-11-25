import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installCompiled, versionProgramPath } from "../src/install/compiled";
import { readCurrent } from "../src/install/current";
import { applyPatch, PatchMismatch, patchAssetName } from "../src/install/patch";
import { compiledAssetName, platformKey } from "../src/utils/lib";
import { fakeProgramScript, RELEASE_BASE, type Scratch, scratch, sha256, stubFetch } from "./release-fixtures";

const ZSTD = Bun.which("zstd");
const CAN_PATCH = process.platform !== "win32" && ZSTD !== null;
const POSIX = process.platform !== "win32";

let box: Scratch | undefined;
let restore: (() => void) | undefined;

afterEach(() => {
	restore?.();
	restore = undefined;
	box?.cleanup();
	box = undefined;
});

function makePatch(dir: string, oldBody: string, newBody: string): Uint8Array {
	const oldFile = join(dir, "old.bin");
	const newFile = join(dir, "new.bin");
	const patchFile = join(dir, "out.zpatch");
	writeFileSync(oldFile, oldBody);
	writeFileSync(newFile, newBody);
	const run = Bun.spawnSync([ZSTD as string, "-q", "-19", "--long=27", "--force", `--patch-from=${oldFile}`, newFile, "-o", patchFile]);
	if (run.exitCode !== 0) throw new Error(run.stderr.toString());
	return new Uint8Array(readFileSync(patchFile));
}

const bodyFor = (version: string) => `${fakeProgramScript(version)}# ${"payload ".repeat(500)}${version}\n`;

describe("patchAssetName", () => {
	test("names the patch after the platform key and the installed version", () => {
		expect(patchAssetName("dg-linux-x64.zst", "7.0.0")).toBe("dg-linux-x64-from-7.0.0.zpatch");
		expect(patchAssetName("dg-windows-x64.exe", "7.0.0")).toBe("dg-windows-x64-from-7.0.0.zpatch");
		expect(patchAssetName("dg-windows-arm64.exe.zst", "1.2.3")).toBe("dg-windows-arm64-from-1.2.3.zpatch");
	});
});

describe("applyPatch", () => {
	test.skipIf(!CAN_PATCH)("returns the new bytes when the result matches the expected sha256", () => {
		box = scratch("apply");
		const [oldBody, newBody] = [bodyFor("7.0.0"), bodyFor("7.0.1")];
		const patch = makePatch(box.directory, oldBody, newBody);
		const out = applyPatch(Buffer.from(oldBody), patch, sha256(newBody));
		expect(Buffer.from(out).toString()).toBe(newBody);
	});

	test.skipIf(!CAN_PATCH)("throws PatchMismatch when the result does not match the expected sha256", () => {
		box = scratch("apply-sum");
		const [oldBody, newBody] = [bodyFor("7.0.0"), bodyFor("7.0.1")];
		const patch = makePatch(box.directory, oldBody, newBody);
		expect(() => applyPatch(Buffer.from(oldBody), patch, sha256("something else"))).toThrow(PatchMismatch);
	});

	test.skipIf(!CAN_PATCH)("throws PatchMismatch when the patch applies to a different old file", () => {
		box = scratch("apply-old");
		const patch = makePatch(box.directory, bodyFor("7.0.0"), bodyFor("7.0.1"));
		expect(() => applyPatch(Buffer.from(bodyFor("6.0.0")), patch, sha256(bodyFor("7.0.1")))).toThrow(PatchMismatch);
	});

	test("throws PatchMismatch for a corrupt patch", () => {
		expect(() => applyPatch(Buffer.from("old"), new Uint8Array([9, 9, 9, 9]), sha256("new"))).toThrow(PatchMismatch);
	});

	test("throws PatchMismatch that names zstd when zstd is missing", () => {
		expect(() => applyPatch(Buffer.from("old"), new Uint8Array([1]), sha256("new"), null)).toThrow(/zstd/);
		expect(() => applyPatch(Buffer.from("old"), new Uint8Array([1]), sha256("new"), null)).toThrow(PatchMismatch);
	});
});

function updateRoute(from: string, to: string, served: { patch?: Uint8Array | string; full?: Uint8Array | string }) {
	const raw = compiledAssetName(platformKey());
	const zst = `${raw}.zst`;
	const base = `${RELEASE_BASE}/v${to}`;
	const toBody = bodyFor(to);
	const routes: Record<string, Uint8Array | string> = {
		[`${base}/SHA256SUMS`]: `${sha256(toBody)}  ${raw}\n${sha256(toBody)}  ${zst}\n`,
		[`${base}/${zst}`]: served.full ?? Bun.zstdCompressSync(toBody),
	};
	if (served.patch !== undefined) routes[`${base}/${patchAssetName(raw, from)}`] = served.patch;
	const stub = stubFetch(routes);
	restore = stub.restore;
	return {
		calls: stub.calls,
		picked: { version: to, assetName: zst, url: `${base}/${zst}`, encoding: "zstd" as const, sumsUrl: `${base}/SHA256SUMS` },
		toBody,
	};
}

async function installPrevious(root: string, version: string): Promise<void> {
	const raw = compiledAssetName(platformKey());
	const body = bodyFor(version);
	const base = `${RELEASE_BASE}/v${version}`;
	const stub = stubFetch({ [`${base}/SHA256SUMS`]: `${sha256(body)}  ${raw}\n`, [`${base}/${raw}`]: body });
	try {
		await installCompiled(root, { version, assetName: raw, url: `${base}/${raw}`, encoding: "raw", sumsUrl: `${base}/SHA256SUMS` });
	} finally {
		stub.restore();
	}
}

describe("installCompiled with a patch from the installed version", () => {
	test.skipIf(!CAN_PATCH)("downloads only the patch and installs the patched program", async () => {
		box = scratch("upd-patch");
		await installPrevious(box.root, "7.0.0");
		const patch = makePatch(box.directory, bodyFor("7.0.0"), bodyFor("7.0.1"));
		const { picked, calls, toBody } = updateRoute("7.0.0", "7.0.1", { patch });
		const path = await installCompiled(box.root, picked);
		expect(readFileSync(path, "utf8")).toBe(toBody);
		expect(readCurrent(box.root, "bin")).toBe("7.0.1");
		expect(calls.some((url) => url.endsWith(".zpatch"))).toBe(true);
		expect(calls.some((url) => url.endsWith(".zst"))).toBe(false);
	});

	test.skipIf(!POSIX)("a corrupt patch falls back to the full .zst", async () => {
		box = scratch("upd-corrupt");
		await installPrevious(box.root, "7.0.0");
		const { picked, calls, toBody } = updateRoute("7.0.0", "7.0.1", { patch: new Uint8Array([1, 2, 3, 4, 5, 6]) });
		const path = await installCompiled(box.root, picked);
		expect(readFileSync(path, "utf8")).toBe(toBody);
		expect(calls.some((url) => url.endsWith(".zst"))).toBe(true);
	});

	test.skipIf(!CAN_PATCH)("a patch that yields the wrong bytes is never installed and the .zst is used", async () => {
		box = scratch("upd-wrong");
		await installPrevious(box.root, "7.0.0");
		const patch = makePatch(box.directory, bodyFor("7.0.0"), `${bodyFor("7.0.1")}# tampered\n`);
		const { picked, calls, toBody } = updateRoute("7.0.0", "7.0.1", { patch });
		const path = await installCompiled(box.root, picked);
		expect(readFileSync(path, "utf8")).toBe(toBody);
		expect(calls.some((url) => url.endsWith(".zst"))).toBe(true);
	});

	test.skipIf(!POSIX)("no patch asset falls back to the full .zst", async () => {
		box = scratch("upd-none");
		await installPrevious(box.root, "7.0.0");
		const { picked, toBody } = updateRoute("7.0.0", "7.0.1", {});
		expect(readFileSync(await installCompiled(box.root, picked), "utf8")).toBe(toBody);
	});

	test.skipIf(!POSIX)("a bad full download after a failed patch installs nothing", async () => {
		box = scratch("upd-both-bad");
		await installPrevious(box.root, "7.0.0");
		const { picked } = updateRoute("7.0.0", "7.0.1", { patch: new Uint8Array([1, 2, 3]), full: Bun.zstdCompressSync("tampered") });
		await expect(installCompiled(box.root, picked)).rejects.toThrow(/checksum mismatch/);
		expect(existsSync(versionProgramPath(box.root, "7.0.1"))).toBe(false);
		expect(readCurrent(box.root, "bin")).toBe("7.0.0");
	});

	test.skipIf(!POSIX)("a first install with nothing installed never asks for a patch", async () => {
		box = scratch("upd-first");
		const { picked, calls } = updateRoute("7.0.0", "7.0.1", {});
		await installCompiled(box.root, picked);
		expect(calls.some((url) => url.endsWith(".zpatch"))).toBe(false);
	});
});
