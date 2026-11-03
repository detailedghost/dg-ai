import { describe, expect, test } from "bun:test";
import type { ControlRow, Reading } from "../src/layout/fingerprint";
import { diffReadings, notChecked, type Difference } from "../src/layout/diff";

const context = { viewport: "desktop", theme: "light", role: "admin" } as const;

function control(name: string, index: number, extra: Partial<ControlRow> = {}): ControlRow {
	return {
		i: index,
		role: "button",
		name,
		testid: null,
		path: `button.${name.toLowerCase().replace(/\s+/g, "-")}`,
		box: { x: 0, y: index * 100, w: 100, h: 40 },
		band: "middle",
		hband: "left",
		visible: true,
		occluded: false,
		occluder: null,
		...extra,
	};
}

function reading(controls: ControlRow[], extra: Partial<Reading> = {}): Reading {
	return {
		viewport: "desktop",
		width: 1440,
		height: 900,
		theme: "light",
		themeApplied: "light",
		root: { x: 0, y: 0, w: 800, h: 1000 },
		controls,
		...extra,
	};
}

const kinds = (rows: Difference[]) => rows.map((row) => row.kind);

describe("diffReadings", () => {
	test("returns nothing for identical readings", () => {
		const one = reading([control("Add note", 0), control("Save", 1)]);
		expect(diffReadings(one, structuredClone(one), context)).toEqual([]);
	});

	test("reports a control the build lacks and a control the prototype lacks", () => {
		const expected = reading([control("Add note", 0), control("Save", 1)]);
		const found = reading([control("Add note", 0), control("Cancel", 1)]);
		const rows = diffReadings(expected, found, context);
		expect(kinds(rows).sort()).toEqual(["extra", "missing"]);
		const missing = rows.find((row) => row.kind === "missing");
		expect(missing?.control).toEqual({ role: "button", name: "Save", testid: null });
		expect(missing?.expected?.path).toBe("button.save");
		expect(missing?.found).toBeNull();
		const extra = rows.find((row) => row.kind === "extra");
		expect(extra?.expected).toBeNull();
		expect(extra?.found?.path).toBe("button.cancel");
	});

	test("reports a control that swapped order with its neighbor", () => {
		const expected = reading([control("A", 0), control("B", 1)]);
		const found = reading([control("B", 0), control("A", 1)]);
		const rows = diffReadings(expected, found, context);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.kind).toBe("reordered");
	});

	test("reports a control that moved from the bottom band to the top band", () => {
		const expected = reading([control("Add note", 0, { band: "bottom", box: { x: 0, y: 900, w: 100, h: 40 } })]);
		const found = reading([control("Add note", 0, { band: "top", box: { x: 0, y: 20, w: 100, h: 40 } })]);
		const rows = diffReadings(expected, found, context);
		expect(kinds(rows)).toEqual(["moved"]);
		expect(rows[0]?.expected?.band).toBe("bottom");
		expect(rows[0]?.found?.band).toBe("top");
	});

	test("ignores a small shift within a band and a band flip inside the dead zone", () => {
		const base = control("Add note", 0, { band: "middle", box: { x: 0, y: 480, w: 100, h: 40 } });
		const shifted = control("Add note", 0, { band: "middle", box: { x: 0, y: 530, w: 100, h: 40 } });
		expect(diffReadings(reading([base]), reading([shifted]), context)).toEqual([]);
		const near = control("Add note", 0, { band: "top", box: { x: 0, y: 330, w: 100, h: 40 } });
		const across = control("Add note", 0, { band: "middle", box: { x: 0, y: 380, w: 100, h: 40 } });
		expect(diffReadings(reading([near]), reading([across]), context)).toEqual([]);
	});

	test("reports a horizontal band move past the dead zone", () => {
		const left = control("Add note", 0, { hband: "left", box: { x: 0, y: 480, w: 100, h: 40 } });
		const right = control("Add note", 0, { hband: "right", box: { x: 650, y: 480, w: 100, h: 40 } });
		expect(kinds(diffReadings(reading([left]), reading([right]), context))).toEqual(["moved"]);
	});

	test("compares positions as fractions of each root", () => {
		const expected = reading([control("Add note", 0, { band: "bottom", box: { x: 0, y: 900, w: 100, h: 40 } })]);
		const found = reading(
			[control("Add note", 0, { band: "bottom", box: { x: 0, y: 1800, w: 100, h: 40 } })],
			{ root: { x: 0, y: 0, w: 800, h: 2000 } },
		);
		expect(diffReadings(expected, found, context)).toEqual([]);
	});

	test("reports a control that went from visible to hidden", () => {
		const expected = reading([control("Menu", 0)]);
		const found = reading([control("Menu", 0, { visible: false })]);
		expect(kinds(diffReadings(expected, found, context))).toEqual(["visibility"]);
	});

	test("reports an occluded control from the build side alone, with the occluder", () => {
		const expected = reading([control("Add note", 0)]);
		const found = reading([control("Add note", 0, { occluded: true, occluder: "nav#bottom-bar" })]);
		const rows = diffReadings(expected, found, context);
		expect(kinds(rows)).toEqual(["occluded"]);
		expect(rows[0]?.found?.occluder).toBe("nav#bottom-bar");
		const both = reading([control("Add note", 0, { occluded: true, occluder: "nav#bottom-bar" })]);
		expect(kinds(diffReadings(both, found, context))).toEqual(["occluded"]);
	});

	test("reports one root-missing row with the reason when the build has no root", () => {
		const expected = reading([control("A", 0), control("B", 1)]);
		const found = reading([], { root: null });
		const rows = diffReadings(expected, found, context, "root: found 0 visible [data-verify-root]");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "root-missing",
			control: null,
			reason: "root: found 0 visible [data-verify-root]",
		});
	});

	test("reports a theme row when the applied theme differs", () => {
		const expected = reading([control("A", 0)], { theme: "dark", themeApplied: "dark" });
		const found = reading([control("A", 0)], { theme: "dark", themeApplied: "light" });
		const rows = diffReadings(expected, found, { ...context, theme: "dark" });
		expect(kinds(rows)).toEqual(["theme"]);
	});

	test("matches by test id across a rename", () => {
		const expected = reading([control("Add note", 0, { testid: "add-note" })]);
		const found = reading([control("New note", 0, { testid: "add-note" })]);
		expect(diffReadings(expected, found, context)).toEqual([]);
	});

	test("matches duplicate names in DOM order", () => {
		const expected = reading([control("Edit", 0, { band: "top", box: { x: 0, y: 10, w: 100, h: 40 } }), control("Edit", 1, { band: "bottom", box: { x: 0, y: 900, w: 100, h: 40 } })]);
		const found = reading([control("Edit", 0, { band: "top", box: { x: 0, y: 10, w: 100, h: 40 } }), control("Edit", 1, { band: "bottom", box: { x: 0, y: 900, w: 100, h: 40 } })]);
		expect(diffReadings(expected, found, context)).toEqual([]);
		const dropped = reading([control("Edit", 0, { band: "top", box: { x: 0, y: 10, w: 100, h: 40 } })]);
		const rows = diffReadings(expected, dropped, context);
		expect(kinds(rows)).toEqual(["missing"]);
	});

	test("derives stable ids that ignore row index and round", () => {
		const expected = reading([control("A", 0), control("Save", 1)]);
		const found = reading([control("A", 0)]);
		const shifted = reading([control("A", 5)]);
		const first = diffReadings(expected, found, context);
		const second = diffReadings(expected, shifted, context);
		expect(first.map((row) => row.id)).toEqual(second.map((row) => row.id));
		expect(first[0]?.id).toMatch(/^d-[0-9a-f]{10}$/);
		const other = diffReadings(expected, found, { ...context, theme: "dark" });
		expect(other[0]?.id).not.toBe(first[0]?.id);
	});
});

describe("notChecked", () => {
	test("makes one all-viewport row that carries its reason", () => {
		const row = notChecked("member", "http engine reads no layout");
		expect(row).toMatchObject({
			kind: "not-checked",
			viewport: "all",
			theme: "all",
			role: "member",
			control: null,
			expected: null,
			found: null,
			reason: "http engine reads no layout",
		});
		expect(notChecked("member", "x").id).toBe(row.id);
		expect(notChecked("admin", "x").id).not.toBe(row.id);
	});
});
