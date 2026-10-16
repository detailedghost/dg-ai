import { describe, expect, test } from "bun:test";
import type { Schedule } from "../src/config";
import { dueWindow, resolveSchedule } from "../src/automation/schedule";

const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

const DAILY: Schedule = { every: "day", day: "mon", window: "02:00-05:00" };
const WEEKLY_WED: Schedule = { every: "week", day: "wed", window: "02:00-05:00" };
const OVERNIGHT: Schedule = { every: "day", day: "mon", window: "22:00-02:00" };

describe("dueWindow", () => {
	test("returns the window while now is inside it", () => {
		expect(dueWindow(local(14, 3, 30), DAILY)).toEqual({
			windowStart: local(14, 2),
			windowEnd: local(14, 5),
		});
	});

	test("includes the start and excludes the end", () => {
		expect(dueWindow(local(14, 2), DAILY)?.windowStart).toEqual(local(14, 2));
		expect(dueWindow(local(14, 5), DAILY)).toBeNull();
	});

	test("does not catch up after a missed window", () => {
		expect(dueWindow(local(14, 1, 59), DAILY)).toBeNull();
		expect(dueWindow(local(14, 9), DAILY)).toBeNull();
	});

	test("runs weekly windows only on the configured day", () => {
		expect(dueWindow(local(14, 3), WEEKLY_WED)?.windowStart).toEqual(local(14, 2));
		expect(dueWindow(local(15, 3), WEEKLY_WED)).toBeNull();
		expect(dueWindow(local(21, 3), WEEKLY_WED)?.windowStart).toEqual(local(21, 2));
	});

	test("keeps one window start across a midnight-crossing window", () => {
		const evening = dueWindow(local(14, 23), OVERNIGHT);
		const morning = dueWindow(local(15, 1, 30), OVERNIGHT);
		expect(evening).toEqual({ windowStart: local(14, 22), windowEnd: local(15, 2) });
		expect(morning).toEqual(evening);
		expect(dueWindow(local(15, 2), OVERNIGHT)).toBeNull();
		expect(dueWindow(local(15, 12), OVERNIGHT)).toBeNull();
	});

	test("anchors a weekly midnight-crossing window to its start day", () => {
		const schedule: Schedule = { ...OVERNIGHT, every: "week", day: "wed" };
		expect(dueWindow(local(15, 1), schedule)?.windowStart).toEqual(local(14, 22));
		expect(dueWindow(local(14, 1), schedule)).toBeNull();
		expect(dueWindow(local(16, 1), schedule)).toBeNull();
	});

	test("returns the same window start on every call inside the window", () => {
		const first = dueWindow(local(14, 2, 1), DAILY);
		const last = dueWindow(local(14, 4, 59), DAILY);
		expect(first?.windowStart.toISOString()).toBe(last?.windowStart.toISOString());
	});
});

describe("resolveSchedule", () => {
	test("lets a repo override only the fields it sets", () => {
		expect(resolveSchedule(DAILY, { day: "sun", window: undefined })).toEqual({
			every: "day",
			day: "sun",
			window: "02:00-05:00",
		});
	});

	test("uses the global schedule when the repo sets nothing", () => {
		expect(resolveSchedule(DAILY, {})).toEqual(DAILY);
	});

	test("applies a per-repo window to dueWindow", () => {
		const own = resolveSchedule(DAILY, { window: "10:00-11:00" });
		expect(dueWindow(local(14, 3), own)).toBeNull();
		expect(dueWindow(local(14, 10, 30), own)?.windowStart).toEqual(local(14, 10));
	});
});
