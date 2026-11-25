import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const SCRIPT = join(REPO_ROOT, "scripts", "lean-size.ts");
const MB = 1024 * 1024;

let work = "";
let dist = "";
let previous = "";
let budgets = "";

function noise(bytes: number, seed: number): Uint8Array {
	const out = new Uint8Array(bytes);
	let state = seed;
	for (let i = 0; i < bytes; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out[i] = state >>> 24;
	}
	return out;
}

function run(...args: string[]) {
	const proc = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: { ...process.env, NO_COLOR: "1" } });
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function reportOf(args: string[]) {
	const json = join(work, `report-${Math.random().toString(36).slice(2)}.json`);
	const result = run(...args, "--json", json);
	return { ...result, report: result.code === 0 ? JSON.parse(readFileSync(json, "utf8")) : null };
}

beforeAll(() => {
	work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "lean-size-"));
	dist = join(work, "dist");
	previous = join(work, "previous");
	mkdirSync(dist);
	mkdirSync(previous);
	const base = noise(1 * MB, 7);
	writeFileSync(join(dist, "dg-linux-x64"), base);
	writeFileSync(join(dist, "dg-windows-x64.exe"), noise(MB / 2, 9));
	const edited = base.slice();
	edited.fill(0xab, 4096, 4096 + 2048);
	writeFileSync(join(previous, "dg-linux-x64"), edited);
	budgets = join(work, "budgets.json");
});

afterAll(() => {
	rmSync(work, { recursive: true, force: true });
});

describe("lean-size measurement", () => {
	test("reports raw, gzip, zstd and patch bytes per target", () => {
		const { code, report } = reportOf(["--dist", dist, "--previous", previous]);
		expect(code).toBe(0);
		const linux = report.size["linux-x64"];
		expect(linux.rawBytes).toBe(1 * MB);
		expect(linux.gzipBytes).toBeGreaterThan(0);
		expect(linux.zstdBytes).toBeGreaterThan(0);
		expect(linux.patchBytes).toBeGreaterThan(0);
		expect(linux.patchBytes).toBeLessThan(linux.zstdBytes / 10);
	});

	test("names the windows target without the exe suffix and skips a missing previous", () => {
		const { report } = reportOf(["--dist", dist, "--previous", previous]);
		expect(Object.keys(report.size).sort()).toEqual(["linux-x64", "windows-x64"]);
		expect(report.size["windows-x64"].patchBytes).toBeNull();
	});

	test("omits patch bytes without --previous", () => {
		const { report } = reportOf(["--dist", dist]);
		expect(report.size["linux-x64"].patchBytes).toBeNull();
	});

	test("fails with a usage error when the dist directory has no binary", () => {
		const empty = join(work, "empty");
		mkdirSync(empty);
		const { code, err } = run("--dist", empty);
		expect(code).toBe(2);
		expect(err).toContain("no dg-<target> binary");
	});
});

describe("lean-size gate", () => {
	function seed(slack = 1024) {
		const { report } = reportOf(["--dist", dist, "--previous", previous]);
		const size = Object.fromEntries(
			Object.entries(report.size as Record<string, { rawBytes: number; zstdBytes: number; patchBytes: number | null }>).map(
				([target, m]) => [
					target,
					{ rawBytes: m.rawBytes + slack, zstdBytes: m.zstdBytes + slack, patchBytes: (m.patchBytes ?? 0) + slack },
				],
			),
		);
		writeFileSync(budgets, JSON.stringify({ size }));
		return size;
	}

	test("passes when every number is within budget", () => {
		seed();
		const { code } = run("--dist", dist, "--previous", previous, "--budgets", budgets, "--gate");
		expect(code).toBe(0);
	});

	test("without --gate an overrun still exits 0", () => {
		seed();
		const big = join(work, "big-ungated");
		mkdirSync(big);
		writeFileSync(join(big, "dg-linux-x64"), noise(3 * MB, 7));
		expect(run("--dist", big, "--budgets", budgets).code).toBe(0);
	});

	test("a binary 2 MB larger fails and names the target with both numbers", () => {
		const size = seed();
		const big = join(work, "big");
		mkdirSync(big);
		writeFileSync(join(big, "dg-linux-x64"), noise(1 * MB + 2 * MB, 7));
		const { code, err } = run("--dist", big, "--budgets", budgets, "--gate");
		expect(code).toBe(1);
		expect(err).toContain("linux-x64");
		expect(err).toContain("rawBytes");
		expect(err).toContain(String(3 * MB));
		expect(err).toContain(String(size["linux-x64"].rawBytes));
	});

	test("an overrun in patch bytes alone fails", () => {
		seed();
		const patched = join(work, "patched");
		mkdirSync(patched);
		writeFileSync(join(patched, "dg-linux-x64"), noise(1 * MB, 11));
		const { code, err } = run("--dist", patched, "--previous", previous, "--budgets", budgets, "--gate");
		expect(code).toBe(1);
		expect(err).toContain("patchBytes");
	});

	test("a target without a budget fails the gate", () => {
		writeFileSync(budgets, JSON.stringify({ size: {} }));
		const { code, err } = run("--dist", dist, "--budgets", budgets, "--gate");
		expect(code).toBe(1);
		expect(err).toContain("no budget for linux-x64");
	});

	test("a budget file with the wrong shape is a usage error", () => {
		writeFileSync(budgets, JSON.stringify({ size: { "linux-x64": { rawBytes: "big" } } }));
		const { code, err } = run("--dist", dist, "--budgets", budgets, "--gate");
		expect(code).toBe(2);
		expect(err).toContain("lean-budgets");
	});
});
