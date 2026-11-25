import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, parseReportFlag, type SizeReport, sizeReportFrom } from "../build/report";

setDefaultTimeout(180_000);

const SIZE_DIFF = join(import.meta.dir, "..", "..", "..", "scripts", "size-diff.ts");

const metafile = (inputs: Record<string, number>) => ({
	outputs: { "./dg.js": { inputs: Object.fromEntries(Object.entries(inputs).map(([path, bytes]) => [path, { bytesInOutput: bytes }])) } },
});

function sizeDiff(base: SizeReport, head: SizeReport) {
	const dir = mkdtempSync(join(tmpdir(), "size-diff-"));
	try {
		writeFileSync(join(dir, "base.json"), JSON.stringify(base));
		writeFileSync(join(dir, "head.json"), JSON.stringify(head));
		const proc = Bun.spawnSync(["bun", SIZE_DIFF, join(dir, "base.json"), join(dir, "head.json")], { stdout: "pipe", stderr: "pipe" });
		return { stdout: proc.stdout.toString(), exitCode: proc.exitCode };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("sizeReportFrom", () => {
	test("sums bytes per package and totals them", () => {
		const report = sizeReportFrom(
			metafile({
				"node_modules/left-pad/index.js": 10,
				"node_modules/left-pad/more.js": 5,
				"../../node_modules/.bun/x/node_modules/@scope/pkg/a.js": 7,
				"pkg/skills-cli/src/main.ts": 3,
			}),
		);
		expect(report.packages["left-pad"]).toBe(15);
		expect(report.packages["@scope/pkg"]).toBe(7);
		expect(report.totalBytes).toBe(25);
	});

	test("merges @aws-sdk, @smithy and @aws-crypto into one row", () => {
		const report = sizeReportFrom(
			metafile({
				"node_modules/@aws-sdk/client-s3/a.js": 100,
				"node_modules/@smithy/core/b.js": 50,
				"node_modules/@aws-crypto/sha256/c.js": 25,
			}),
		);
		expect(report.packages).toEqual({ "aws-sdk": 175 });
	});

	test("orders rows by bytes descending", () => {
		const report = sizeReportFrom(metafile({ "node_modules/a/x.js": 1, "node_modules/b/x.js": 9 }));
		expect(Object.keys(report.packages)).toEqual(["b", "a"]);
	});
});

describe("parseReportFlag", () => {
	test("returns the path after --report", () => {
		expect(parseReportFlag(["--outdir", "x", "--report", "r.json"])).toBe("r.json");
		expect(parseReportFlag(["--report=r.json"])).toBe("r.json");
		expect(parseReportFlag(["--outdir", "x"])).toBeUndefined();
	});
});

describe("size-diff", () => {
	test("prints only the modules that grew, biggest growth first", () => {
		const { stdout, exitCode } = sizeDiff(
			{ totalBytes: 300, packages: { a: 100, b: 100, c: 100 } },
			{ totalBytes: 420, packages: { a: 90, b: 130, c: 200 } },
		);
		expect(exitCode).toBe(0);
		const lines = stdout.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("c");
		expect(lines[0]).toContain("+100");
		expect(lines[1]).toContain("b");
		expect(lines[1]).toContain("+30");
		expect(stdout).not.toContain("a ");
	});

	test("counts a new module as growth and prints nothing when nothing grew", () => {
		const grew = sizeDiff({ totalBytes: 1, packages: { a: 1 } }, { totalBytes: 6, packages: { a: 1, fresh: 5 } });
		expect(grew.stdout).toContain("fresh");
		expect(grew.stdout).toContain("+5");
		const flat = sizeDiff({ totalBytes: 1, packages: { a: 1 } }, { totalBytes: 1, packages: { a: 1 } });
		expect(flat.stdout.trim()).toBe("");
	});
});

describe("buildReport", () => {
	test("writes a report whose top row is playwright-core", async () => {
		const dir = mkdtempSync(join(tmpdir(), "build-report-"));
		try {
			const file = join(dir, "size-report.json");
			await buildReport(file);
			const report = JSON.parse(readFileSync(file, "utf8")) as SizeReport;
			expect(Object.keys(report.packages)[0]).toBe("playwright-core");
			expect(report.totalBytes).toBe(Object.values(report.packages).reduce((sum, bytes) => sum + bytes, 0));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
