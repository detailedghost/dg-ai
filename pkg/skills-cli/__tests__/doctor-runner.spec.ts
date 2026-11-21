import { describe, expect, test } from "bun:test";
import { formatFailures } from "../src/doctor/runner";
import type { CheckReport, DoctorReport } from "../src/doctor/types";

const check = (id: string, status: CheckReport["status"], detail = `${id} detail`, fix: string | null = null): CheckReport => ({
	id,
	status,
	detail,
	fix,
});

const report = (items: DoctorReport["items"]): DoctorReport => ({
	items,
	ok: !items.some((entry) => entry.checks.some((c) => c.status === "fail")),
});

describe("formatFailures", () => {
	test("lists only failed checks with item, id and first detail line", () => {
		const text = formatFailures(
			report([
				{ item: "shared", checks: [check("ok-one", "ok"), check("warn-one", "warn"), check("info-one", "info")] },
				{ item: "ext", checks: [check("bad", "fail", "first line\nsecond line")] },
			]),
		);
		expect(text).toBe("  ❌ ext / bad: first line");
	});

	test("omits the detail part when a failure has no detail", () => {
		expect(formatFailures(report([{ item: "ext", checks: [check("bad", "fail", "")] }]))).toBe("  ❌ ext / bad");
		expect(formatFailures(report([{ item: "ext", checks: [check("bad", "fail", "", "dg install ext")] }]))).toBe(
			"  ❌ ext / bad\n      Fix: dg install ext",
		);
	});

	test("adds a fix line under a failure that has a fix", () => {
		const text = formatFailures(
			report([{ item: "ext", checks: [check("bad", "fail", "broken", "dg install ext"), check("worse", "fail", "gone")] }]),
		);
		expect(text.split("\n")).toEqual([
			"  ❌ ext / bad: broken",
			"      Fix: dg install ext",
			"  ❌ ext / worse: gone",
		]);
	});

	test("returns an empty string when nothing fails", () => {
		expect(formatFailures(report([{ item: "shared", checks: [check("a", "ok"), check("b", "warn")] }]))).toBe("");
	});
});
