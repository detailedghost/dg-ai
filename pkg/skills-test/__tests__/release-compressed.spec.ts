import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_KEYS } from "../../skills-cli/__tests__/release-fixtures";
import { compiledAssetName } from "../../skills-cli/src/utils/lib";
import { parseWorkflow } from "./workflow-support";

const release = parseWorkflow("release.yml");

function runStep(name: string): string {
	const step = release.jobs.release?.steps?.find((s) => s.name === name);
	if (!step?.run) throw new Error(`release.yml has no run step named "${name}"`);
	return step.run;
}

function sh(script: string, cwd: string): void {
	const proc = Bun.spawnSync(["bash", "-euo", "pipefail", "-c", script], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`step failed: ${proc.stderr.toString()}`);
}

describe("the release step that compresses the compiled dg", () => {
	test("publishes .zst and .gz next to each of the eight raw assets, and SHA256SUMS covers all", () => {
		const work = mkdtempSync(join(tmpdir(), "dg-release-compress-"));
		try {
			const dist = join(work, "dist");
			mkdirSync(dist);
			mkdirSync(join(work, "pkg", "skills-cli"), { recursive: true });
			writeFileSync(join(work, "pkg", "skills-cli", "bootstrap.sh"), "sh\n");
			writeFileSync(join(work, "pkg", "skills-cli", "bootstrap.ps1"), "ps\n");
			writeFileSync(join(dist, "dg-lib-1.0.0.tar.gz"), "lib");
			for (const key of PLATFORM_KEYS) writeFileSync(join(dist, compiledAssetName(key)), `program ${key} `.repeat(500));

			sh(runStep("Compress the compiled dg assets"), work);
			sh(runStep("Add the bootstrap scripts and checksums"), work);

			const files = readdirSync(dist);
			const sums = readFileSync(join(dist, "SHA256SUMS"), "utf8");
			for (const key of PLATFORM_KEYS) {
				const raw = compiledAssetName(key);
				for (const name of [raw, `${raw}.zst`, `${raw}.gz`]) {
					expect(files).toContain(name);
					expect(sums).toMatch(new RegExp(`^[0-9a-f]{64}  ${name.replaceAll(".", "\\.")}$`, "m"));
				}
				const unpacked = Bun.zstdDecompressSync(readFileSync(join(dist, `${raw}.zst`)));
				expect(Buffer.from(unpacked).equals(readFileSync(join(dist, raw)))).toBe(true);
				const gunzipped = Bun.gunzipSync(readFileSync(join(dist, `${raw}.gz`)));
				expect(Buffer.from(gunzipped).equals(readFileSync(join(dist, raw)))).toBe(true);
			}
			expect(files).not.toContain("dg-lib-1.0.0.tar.gz.zst");
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	test("runs before the checksums are written", () => {
		const names = (release.jobs.release?.steps ?? []).map((s) => s.name);
		expect(names.indexOf("Compress the compiled dg assets")).toBeGreaterThan(-1);
		expect(names.indexOf("Compress the compiled dg assets")).toBeLessThan(names.indexOf("Add the bootstrap scripts and checksums"));
	});
});
