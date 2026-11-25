import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCompiled, buildLauncher } from "../build/compile";
import { COMPILE_TARGETS, type CompileKey, type SharedOptions } from "../build/options";

const shared = {
	options: { entrypoints: ["entry.ts"], target: "bun", splitting: true, minify: true },
	version: "0.0.0",
	sha: "test",
} as unknown as SharedOptions;

describe("buildCompiled options", () => {
	let build: ReturnType<typeof spyOn<typeof Bun, "build">>;
	beforeAll(() => {
		build = spyOn(Bun, "build");
	});
	afterEach(() => build.mockReset());
	afterAll(() => build.mockRestore());

	for (const target of Object.keys(COMPILE_TARGETS) as CompileKey[]) {
		test(`${target} compiles with bytecode and splitting on`, async () => {
			build.mockResolvedValue({ success: true, outputs: [], logs: [] } as unknown as Bun.BuildOutput);
			await buildCompiled({ target, outfile: join(tmpdir(), "dg-build-compile-spec", target), shared });
			const [config] = build.mock.calls[0] as [Bun.BuildConfig];
			expect(config.bytecode).toBe(true);
			expect(config.splitting).toBe(true);
			expect(config.format).toBe("esm");
			expect(config.compile).toMatchObject({ target: COMPILE_TARGETS[target] });
		});
	}
});

describe("buildLauncher output directory", () => {
	let build: ReturnType<typeof spyOn<typeof Bun, "build">>;
	beforeAll(() => {
		build = spyOn(Bun, "build");
	});
	afterEach(() => build.mockReset());
	afterAll(() => build.mockRestore());

	test("clears the lib folder and leaves other files in the output directory alone", async () => {
		const outdir = mkdtempSync(join(tmpdir(), "dg-build-launcher-"));
		try {
			mkdirSync(join(outdir, "lib"));
			writeFileSync(join(outdir, "lib", "stale.js"), "");
			writeFileSync(join(outdir, "keep.txt"), "keep");
			build.mockImplementation((async (config: Bun.BuildConfig) => {
				mkdirSync(config.outdir as string, { recursive: true });
				return { success: true, outputs: [], logs: [] };
			}) as unknown as typeof Bun.build);
			await buildLauncher(outdir);
			expect(existsSync(join(outdir, "lib", "stale.js"))).toBe(false);
			expect(existsSync(join(outdir, "keep.txt"))).toBe(true);
		} finally {
			rmSync(outdir, { recursive: true, force: true });
		}
	});
});
