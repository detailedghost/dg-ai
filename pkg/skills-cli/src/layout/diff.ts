import { createHash } from "node:crypto";
import type { ThemeName, ViewportId } from "../verify/capture-model";
import { type Box, type ControlRow, identityKeys, type Reading } from "./fingerprint";

export type DifferenceKind =
	| "root-missing"
	| "missing"
	| "extra"
	| "reordered"
	| "moved"
	| "visibility"
	| "occluded"
	| "theme"
	| "not-checked";

export interface Side {
	path: string;
	box: Box;
	band: string;
	hband: string;
	visible: boolean;
	occluder?: string | null;
}

export interface Difference {
	id: string;
	viewport: ViewportId | "all";
	theme: ThemeName | "all";
	role: string;
	kind: DifferenceKind;
	control: { role: string; name: string; testid: string | null } | null;
	expected: Side | null;
	found: Side | null;
	reason?: string;
}

export interface DiffContext {
	viewport: ViewportId;
	theme: ThemeName;
	role: string;
}

export interface LayoutCheck {
	status: "pass" | "fail" | "not-checked";
	differences: Difference[];
}

const DEAD_ZONE = 0.1;

const idOf = (...parts: string[]): string =>
	`d-${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10)}`;

const sideOf = (row: ControlRow): Side => ({
	path: row.path,
	box: row.box,
	band: row.band,
	hband: row.hband,
	visible: row.visible,
	occluder: row.occluder,
});

const centers = (row: ControlRow, root: Box) => ({
	fx: root.w > 0 ? (row.box.x + row.box.w / 2) / root.w : 0,
	fy: root.h > 0 ? (row.box.y + row.box.h / 2) / root.h : 0,
});

function longestCommon(left: readonly string[], right: readonly string[]): Set<string> {
	const table = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
	for (let a = left.length - 1; a >= 0; a--)
		for (let b = right.length - 1; b >= 0; b--)
			(table[a] as number[])[b] =
				left[a] === right[b]
					? ((table[a + 1] as number[])[b + 1] as number) + 1
					: Math.max((table[a + 1] as number[])[b] as number, (table[a] as number[])[b + 1] as number);
	const kept = new Set<string>();
	let a = 0;
	let b = 0;
	while (a < left.length && b < right.length) {
		if (left[a] === right[b]) {
			kept.add(left[a] as string);
			a++;
			b++;
		} else if (((table[a + 1] as number[])[b] as number) >= ((table[a] as number[])[b + 1] as number)) a++;
		else b++;
	}
	return kept;
}

/** The single row that stands in for a role whose layout could not be read. */
export function notChecked(role: string, reason: string): Difference {
	return {
		id: idOf("all", "all", role, "not-checked", ""),
		viewport: "all",
		theme: "all",
		role,
		kind: "not-checked",
		control: null,
		expected: null,
		found: null,
		reason,
	};
}

/** Summarize a role's rows into the section's layout check. */
export function layoutCheck(differences: Difference[]): LayoutCheck {
	if (differences.length === 0) return { status: "pass", differences };
	return {
		status: differences.every((row) => row.kind === "not-checked") ? "not-checked" : "fail",
		differences,
	};
}

/** Diff one accepted reading against the build's reading of the same viewport and theme. */
export function diffReadings(
	expected: Reading,
	found: Reading,
	context: DiffContext,
	rootReason?: string,
): Difference[] {
	const make = (
		kind: DifferenceKind,
		key: string,
		control: ControlRow | null,
		sides: { expected: ControlRow | null; found: ControlRow | null },
		detail = "",
	): Difference => ({
		id: idOf(context.viewport, context.theme, context.role, kind, key, detail),
		viewport: context.viewport,
		theme: context.theme,
		role: context.role,
		kind,
		control: control ? { role: control.role, name: control.name, testid: control.testid } : null,
		expected: sides.expected ? sideOf(sides.expected) : null,
		found: sides.found ? sideOf(sides.found) : null,
	});

	if (!found.root || !expected.root) {
		const row = make("root-missing", "", null, { expected: null, found: null });
		return [rootReason ? { ...row, reason: rootReason } : row];
	}

	const rows: Difference[] = [];
	if (expected.themeApplied !== found.themeApplied) {
		const row = make("theme", "", null, { expected: null, found: null });
		rows.push({ ...row, reason: `expected ${expected.themeApplied}, found ${found.themeApplied}` });
	}

	const expectedKeys = identityKeys(expected.controls);
	const foundKeys = identityKeys(found.controls);
	const expectedByKey = new Map(expectedKeys.map((key, index) => [key, expected.controls[index] as ControlRow]));
	const foundByKey = new Map(foundKeys.map((key, index) => [key, found.controls[index] as ControlRow]));

	for (const key of expectedKeys) {
		const was = expectedByKey.get(key) as ControlRow;
		if (!foundByKey.has(key)) rows.push(make("missing", key, was, { expected: was, found: null }));
	}
	for (const key of foundKeys) {
		const now = foundByKey.get(key) as ControlRow;
		if (!expectedByKey.has(key)) rows.push(make("extra", key, now, { expected: null, found: now }));
	}

	const sharedExpected = expectedKeys.filter((key) => foundByKey.has(key));
	const sharedFound = foundKeys.filter((key) => expectedByKey.has(key));
	const inOrder = longestCommon(sharedExpected, sharedFound);
	for (const key of sharedFound) {
		const was = expectedByKey.get(key) as ControlRow;
		const now = foundByKey.get(key) as ControlRow;
		const sides = { expected: was, found: now };
		if (!inOrder.has(key)) rows.push(make("reordered", key, now, sides));
		const before = centers(was, expected.root);
		const after = centers(now, found.root);
		const movedVertically = was.band !== now.band && Math.abs(before.fy - after.fy) >= DEAD_ZONE;
		const movedAcross = was.hband !== now.hband && Math.abs(before.fx - after.fx) >= DEAD_ZONE;
		if (movedVertically || movedAcross) rows.push(make("moved", key, now, sides, `${now.band}/${now.hband}`));
		if (was.visible !== now.visible) rows.push(make("visibility", key, now, sides, String(now.visible)));
		if (was.occluded !== now.occluded)
			rows.push(make("occluded", key, now, sides, now.occluded ? (now.occluder ?? "covered") : "clear"));
	}
	return rows;
}
