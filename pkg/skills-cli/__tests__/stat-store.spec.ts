import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addItem } from "../src/stat/checklist";
import { emptyModel } from "../src/stat/model";
import { checklistPath, readChecklist, writeChecklist } from "../src/stat/store";

function withIsolatedState<T>(run: () => T): T {
	const root = mkdtempSync(join(tmpdir(), "dg-stat-store-"));
	const prevState = process.env.AI_STATE_DIR;
	const prevHome = process.env.HOME;
	process.env.AI_STATE_DIR = join(root, "state");
	process.env.HOME = join(root, "home");
	try {
		return run();
	} finally {
		process.env.AI_STATE_DIR = prevState;
		process.env.HOME = prevHome;
		rmSync(root, { recursive: true, force: true });
	}
}

describe("checklist store", () => {
	test("reading a missing checklist returns an empty model and creates no file", () => {
		withIsolatedState(() => {
			const path = checklistPath();
			expect(readChecklist(path)).toEqual(emptyModel());
			expect(readdirSync(dirname(path))).toEqual([]);
		});
	});

	test("writing then reading round-trips the model", () => {
		withIsolatedState(() => {
			const path = checklistPath();
			const added = addItem(emptyModel(), "Phone feature to PR", { status: "running" });
			if (!added.ok) throw new Error("expected success");
			writeChecklist(path, added.model);
			expect(readChecklist(path)).toEqual(added.model);
		});
	});

	test("writing leaves no stray temp file behind", () => {
		withIsolatedState(() => {
			const path = checklistPath();
			const added = addItem(emptyModel(), "x");
			if (!added.ok) throw new Error("expected success");
			writeChecklist(path, added.model);
			const entries = readdirSync(dirname(path));
			expect(entries).toEqual(["checklist.md"]);
		});
	});

	test("checklistPath resolves under AI_STATE_DIR, not the dg daemon home", () => {
		withIsolatedState(() => {
			const path = checklistPath();
			expect(path.startsWith(join(process.env.AI_STATE_DIR as string, "stat"))).toBe(true);
		});
	});
});
