import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addItem } from "../src/stat/checklist";
import { type ChecklistModel, emptyModel } from "../src/stat/model";
import { checklistPath, readChecklist, updateChecklist, writeChecklist } from "../src/stat/store";

async function withIsolatedState<T>(run: () => T | Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "dg-stat-store-"));
	const prevState = process.env.AI_STATE_DIR;
	const prevHome = process.env.HOME;
	process.env.AI_STATE_DIR = join(root, "state");
	process.env.HOME = join(root, "home");
	try {
		return await run();
	} finally {
		process.env.AI_STATE_DIR = prevState;
		process.env.HOME = prevHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function mustAdd(model: ChecklistModel, text: string) {
	const added = addItem(model, text);
	if (!added.ok) throw new Error("expected add to succeed");
	return added;
}

describe("checklist store", () => {
	test("reading a missing checklist returns an empty model and creates no file", async () => {
		await withIsolatedState(() => {
			const path = checklistPath();
			expect(readChecklist(path)).toEqual(emptyModel());
			expect(readdirSync(dirname(path))).toEqual([]);
		});
	});

	test("writing then reading round-trips the model", async () => {
		await withIsolatedState(() => {
			const path = checklistPath();
			const added = addItem(emptyModel(), "Phone feature to PR", { status: "running" });
			if (!added.ok) throw new Error("expected success");
			writeChecklist(path, added.model);
			expect(readChecklist(path)).toEqual(added.model);
		});
	});

	test("writing leaves no stray temp file behind", async () => {
		await withIsolatedState(() => {
			const path = checklistPath();
			const added = addItem(emptyModel(), "x");
			if (!added.ok) throw new Error("expected success");
			writeChecklist(path, added.model);
			const entries = readdirSync(dirname(path));
			expect(entries).toEqual(["checklist.md"]);
		});
	});

	test("checklistPath resolves under AI_STATE_DIR, not the dg daemon home", async () => {
		await withIsolatedState(() => {
			const path = checklistPath();
			expect(path.startsWith(join(process.env.AI_STATE_DIR as string, "stat"))).toBe(true);
		});
	});

	test("updateChecklist applies concurrent mutations without dropping one", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			await Promise.all(
				["a", "b", "c"].map((text) => updateChecklist(path, (model) => mustAdd(model, text))),
			);
			expect(readChecklist(path).open.map((item) => item.text).sort()).toEqual(["a", "b", "c"]);
			expect(readdirSync(dirname(path)).sort()).toEqual(["checklist.md"]);
		});
	});

	test("a thrown mutation releases the lock and does not write", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			await updateChecklist(path, (model) => mustAdd(model, "keep"));
			await expect(
				updateChecklist(path, () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(readChecklist(path).open.map((item) => item.text)).toEqual(["keep"]);
			expect(existsSync(`${path}.lock`)).toBe(false);
		});
	});
});
