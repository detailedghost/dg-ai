/**
 * Unit coverage for `resolveBrowserBinary` — the PATH/override resolution logic
 * in cdp-harness.ts, previously exercised only incidentally through the full
 * CDP e2e suite in demo-verify.spec.ts. Each case runs in a fresh subprocess
 * (see module-call.ts) since Bun.which snapshots PATH at process start, not at
 * call time, and to avoid leaking PATH/DG_VERIFY_BROWSER mutations into
 * sibling spec files that share this same bun:test process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoVerifyHarness } from "../src/utils/cdp-harness";
import { callInSubprocess } from "./module-call";

const CDP_HARNESS = join(
	import.meta.dir,
	"..",
	"src",
	"utils",
	"cdp-harness.ts",
);

/** A no-op executable Bun.which can find by name — content is irrelevant since
 *  resolveBrowserBinary only resolves the path, it never runs the binary. */
function writeFakeBinary(dir: string, name: string): string {
	const path = join(dir, name);
	writeFileSync(path, "#!/bin/sh\nexit 0\n");
	chmodSync(path, 0o755);
	return path;
}

describe("resolveBrowserBinary", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});

	test("DG_VERIFY_BROWSER override is returned verbatim, even with a real candidate on PATH", async () => {
		const sentinel = "/dg-verify-test-sentinel-browser";
		const result = await callInSubprocess(CDP_HARNESS, "resolveBrowserBinary", {
			DG_VERIFY_BROWSER: sentinel,
		});
		expect(result).toEqual({ ok: true, value: sentinel });
	});

	test("throws naming the candidate list when neither an override nor any candidate binary is on PATH", async () => {
		const emptyBin = mkdtempSync(join(tmpdir(), "dg-verify-empty-bin-"));
		dirs.push(emptyBin);
		const result = await callInSubprocess(CDP_HARNESS, "resolveBrowserBinary", {
			DG_VERIFY_BROWSER: undefined,
			PATH: emptyBin,
		});
		expect(result.ok).toBe(false);
		const error = (result as { ok: false; error: string }).error;
		expect(error).toContain("DG_VERIFY_BROWSER");
		expect(error).toContain("brave-browser");
	});

	test("resolves a candidate found via a PATH scan, not just the override", async () => {
		const bin = mkdtempSync(join(tmpdir(), "dg-verify-bin-"));
		dirs.push(bin);
		const fake = writeFakeBinary(bin, "chromium");
		const result = await callInSubprocess(CDP_HARNESS, "resolveBrowserBinary", {
			DG_VERIFY_BROWSER: undefined,
			PATH: bin,
		});
		expect(result).toEqual({ ok: true, value: fake });
	});

	test("prefers brave-browser over chromium when both are on PATH", async () => {
		const bin = mkdtempSync(join(tmpdir(), "dg-verify-bin-"));
		dirs.push(bin);
		writeFakeBinary(bin, "chromium");
		const brave = writeFakeBinary(bin, "brave-browser");
		const result = await callInSubprocess(CDP_HARNESS, "resolveBrowserBinary", {
			DG_VERIFY_BROWSER: undefined,
			PATH: bin,
		});
		expect(result).toEqual({ ok: true, value: brave });
	});
});

describe("DemoVerifyHarness.launch failure cleanup", () => {
	test("a failed launch (bad DG_VERIFY_BROWSER) does not leak its throwaway profile dir", async () => {
		const { readdirSync } = await import("node:fs");
		const leaked = () =>
			readdirSync(tmpdir()).filter((f) => f.startsWith("dg-verify-profile-"));
		const before = new Set(leaked());
		process.env.DG_VERIFY_BROWSER = "/nonexistent/binary-xyz-zzz";
		try {
			await expect(
				DemoVerifyHarness.launch("/tmp/dg-verify-fake-extension-dir"),
			).rejects.toThrow();
		} finally {
			delete process.env.DG_VERIFY_BROWSER;
		}
		expect(leaked().filter((d) => !before.has(d))).toEqual([]);
	});
});
