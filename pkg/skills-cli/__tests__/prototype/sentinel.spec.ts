import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decisionPath, reloadPath, selectionPath } from "../../src/prototype/paths";
import {
	confirmSelection,
	selectionStatus,
	waitForDecision,
	waitForSelection,
} from "../../src/prototype/sentinel";

const cleanupDirs: string[] = [];
let originalScratchDir: string | undefined;

function freshDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

beforeEach(() => {
	originalScratchDir = process.env.AI_SCRATCH_DIR;
	process.env.AI_SCRATCH_DIR = freshDir("proto-sentinel-scratch-");
});

afterEach(() => {
	if (originalScratchDir === undefined) delete process.env.AI_SCRATCH_DIR;
	else process.env.AI_SCRATCH_DIR = originalScratchDir;
	for (const dir of cleanupDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("selectionStatus", () => {
	test("reports pending when nothing has been written", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		expect(await selectionStatus("pending-proto", { cwd, light: true })).toBe("pending");
	});

	test("reports the confirmed variant, trimmed", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		await confirmSelection("confirmed-proto", "VariantB", { cwd, light: true });
		expect(await selectionStatus("confirmed-proto", { cwd, light: true })).toBe("VariantB");
	});

	test("reports rejected without consuming the sentinel", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		const path = await selectionPath("reject-status", { cwd, light: true });
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path.replace(/\.selection$/, ".reject"), "not good");

		expect(await selectionStatus("reject-status", { cwd, light: true })).toBe("rejected");
		expect(await selectionStatus("reject-status", { cwd, light: true })).toBe("rejected");
	});
});

describe("waitForSelection", () => {
	test("resolves ok with notes and consumes both sentinels", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		await confirmSelection("wait-ok", "VariantC", { cwd, light: true, notes: "ship it" });

		const result = await waitForSelection("wait-ok", { cwd, light: true, timeoutMs: 2_000 });

		expect(result).toEqual({ status: "ok", variant: "VariantC", notes: "ship it" });
		const selection = await selectionPath("wait-ok", { cwd, light: true });
		expect(existsSync(selection)).toBe(false);
	});

	test("resolves rejected and consumes the reject sentinel", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		const selection = await selectionPath("wait-reject", { cwd, light: true });
		const rejectFile = selection.replace(/\.selection$/, ".reject");
		mkdirSync(join(selection, ".."), { recursive: true });
		writeFileSync(rejectFile, "too busy, try flatter neutrals");

		const result = await waitForSelection("wait-reject", { cwd, light: true, timeoutMs: 2_000 });

		expect(result).toEqual({ status: "rejected", notes: "too busy, try flatter neutrals" });
		expect(existsSync(rejectFile)).toBe(false);
	});

	test("genuinely times out when no sentinel ever appears", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		const result = await waitForSelection("wait-timeout", { cwd, light: true, timeoutMs: 400 });
		expect(result).toEqual({ status: "timeout" });
	});

	test("picks up a sentinel written mid-wait by another writer", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		const waiter = waitForSelection("wait-async", { cwd, light: true, timeoutMs: 3_000 });
		setTimeout(() => {
			confirmSelection("wait-async", "VariantA", { cwd, light: true }).catch(() => {});
		}, 200);
		expect(await waiter).toEqual({ status: "ok", variant: "VariantA", notes: "" });
	});
});

describe("waitForDecision", () => {
	test("extracts the decision value in non-json mode and consumes the sentinel", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		const path = await decisionPath("decision-ok", { cwd, light: true });
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ decision: "APPROVED", notes: "looks good" })}\n`);

		const result = await waitForDecision("decision-ok", { cwd, light: true, timeoutMs: 2_000 });

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.decision).toBe("APPROVED");
			expect(result.raw).toContain("looks good");
		}
		expect(existsSync(path)).toBe(false);
	});

	test("times out when no decision is ever written", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		const result = await waitForDecision("decision-timeout", { cwd, light: true, timeoutMs: 400 });
		expect(result).toEqual({ status: "timeout" });
	});

	test("returns a stale pre-existing decision immediately (dumb file-existence contract)", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		const path = await decisionPath("decision-stale", { cwd, light: true });
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ decision: "REWORK", notes: "" })}\n`);

		const start = Date.now();
		const result = await waitForDecision("decision-stale", { cwd, light: true, timeoutMs: 5_000 });
		expect(Date.now() - start).toBeLessThan(1_000);
		expect(result.status).toBe("ok");
		if (result.status === "ok") expect(result.decision).toBe("REWORK");
	});
});

describe("reload token", () => {
	test("reload-path points next to the selection sentinel's directory", async () => {
		const cwd = freshDir("proto-sentinel-cwd-");
		const [selection, reload] = await Promise.all([
			selectionPath("reload-proto", { cwd, light: true }),
			reloadPath("reload-proto", { cwd, light: true }),
		]);
		expect(reload).toBe(join(dirname(selection), ".reload"));
	});
});
