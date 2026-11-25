import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCompiled } from "../build/compile";
import { COMPILE_TARGETS, type CompileKey, type SharedOptions } from "../build/options";

const shared = {
	options: { entrypoints: ["entry.ts"], target: "bun", splitting: true, minify: true },
	version: "0.0.0",
	sha: "test",
} as unknown as SharedOptions;

describe("buildCompiled options", () => {
	const build = spyOn(Bun, "build");
	afterEach(() => build.mockReset());

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
