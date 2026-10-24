import { describe, expect, test } from "bun:test";
import {
	addItem,
	computeTotal,
	flattenForDisplay,
	markDone,
	parseChecklist,
	renderEmoji,
	renderJsonModel,
	renderLong,
	renderPlain,
	sanitizeText,
	serializeChecklist,
	setStatus,
} from "../src/stat/checklist";
import {
	type ChecklistItem,
	type ChecklistModel,
	emptyModel,
	STATUS_EMOJI,
	STATUSES,
} from "../src/stat/model";

function item(text: string, overrides: Partial<ChecklistItem> = {}): ChecklistItem {
	return { text, status: "queued", children: [], ...overrides };
}

describe("sanitizeText", () => {
	test("collapses tabs, carriage returns and newlines into a single space, and trims", () => {
		expect(sanitizeText("  foo\tbar\r\nbaz  ")).toBe("foo bar baz");
	});
});

describe("parseChecklist / serializeChecklist round trip", () => {
	test("round-trips open items, a sub-item and an eta suffix", () => {
		const model: ChecklistModel = {
			open: [
				item("Phone feature to PR", { status: "running", eta: "~1 hr" }),
				item("Slice 6", { eta: "~15 min" }),
			],
			done: [],
		};
		model.open[0]!.children.push(item("Fix the flaky listener test", { status: "running" }));
		const text = serializeChecklist(model);
		expect(text).toBe(
			[
				"1. [ ] running: Phone feature to PR [~1 hr]",
				"   1. [ ] running: Fix the flaky listener test",
				"2. [ ] queued: Slice 6 [~15 min]",
				"",
			].join("\n"),
		);
		expect(parseChecklist(text)).toEqual(model);
	});

	test("round-trips done items with a blank line separating them from open items", () => {
		const model: ChecklistModel = {
			open: [item("Slice 6")],
			done: [item("Sign in to GitHub", { status: "done" })],
		};
		const text = serializeChecklist(model);
		expect(text).toBe(
			["1. [ ] queued: Slice 6", "", "2. [x] done: Sign in to GitHub", ""].join("\n"),
		);
		expect(parseChecklist(text)).toEqual(model);
	});

	test("parses an unrecognized status word as an error", () => {
		expect(() => parseChecklist("1. [ ] bogus: text\n")).toThrow(/unrecognized status/);
	});

	test("an empty model serializes to an empty string and parses back to empty", () => {
		expect(serializeChecklist(emptyModel())).toBe("");
		expect(parseChecklist("")).toEqual(emptyModel());
	});
});

describe("flattenForDisplay ordering and numbering", () => {
	test("numbers open items first, then done items continuing the same sequence, restarting children at 1", () => {
		const model: ChecklistModel = {
			open: [item("Open one"), item("Open two")],
			done: [item("Done one", { status: "done" })],
		};
		model.open[0]!.children.push(item("Child a"), item("Child b"));
		const { rows, hiddenDoneCount } = flattenForDisplay(model);
		expect(rows.map((r) => r.order)).toEqual(["1", "1.1", "1.2", "2", "3"]);
		expect(hiddenDoneCount).toBe(0);
	});

	test("caps done items to the newest N and reports how many more are hidden", () => {
		const done = Array.from({ length: 12 }, (_, i) => item(`done ${i}`, { status: "done" }));
		const { rows, hiddenDoneCount } = flattenForDisplay({ open: [], done }, 10);
		expect(rows).toHaveLength(10);
		expect(rows[0]?.text).toBe("done 0");
		expect(hiddenDoneCount).toBe(2);
	});
});

describe("computeTotal", () => {
	test("picks the open agent item with the largest eta bucket", () => {
		const model: ChecklistModel = {
			open: [
				item("small", { eta: "<5 min" }),
				item("big", { status: "running", eta: ">1 hr" }),
				item("user work", { status: "blocked-user", eta: ">1 hr" }),
			],
			done: [],
		};
		expect(computeTotal(model)).toEqual({
			bucket: ">1 hr",
			label: { order: "2", text: "big" },
		});
	});

	test("returns an unlabeled unknown total when no open agent item has a known eta", () => {
		const model: ChecklistModel = { open: [item("user only", { status: "needs-user" })], done: [] };
		expect(computeTotal(model)).toEqual({ bucket: "unknown" });
	});

	test("returns null when there are no open items at all", () => {
		expect(computeTotal({ open: [], done: [item("done", { status: "done" })] })).toBeNull();
	});
});

describe("renderers", () => {
	function sample(): ChecklistModel {
		const parent = item("Phone feature to PR", { status: "running", eta: "~1 hr" });
		parent.children.push(item("Fix the flaky listener test", { status: "running" }));
		return {
			open: [parent, item("Approve the Wave 6/7 PR batch", { status: "blocked-user" })],
			done: [item("Sign in to GitHub", { status: "done" })],
		};
	}

	test("renderEmoji carries every status's own emoji from STATUS_EMOJI, not just a few", () => {
		const nonDone = STATUSES.filter((status) => status !== "done");
		const model: ChecklistModel = {
			open: nonDone.map((status) => item(status, { status })),
			done: [item("done", { status: "done" })],
		};
		const lines = renderEmoji(model).split("\n").filter((line) => /^\d/.test(line));
		expect(lines).toHaveLength(STATUSES.length);
		for (const [index, status] of [...nonDone, "done" as const].entries())
			expect(lines[index]).toContain(STATUS_EMOJI[status]);
	});

	test("renderEmoji shows emoji, an eta suffix on the agent item, none on the user item, and a blank line before Total", () => {
		const out = renderEmoji(sample());
		expect(out).toBe(
			[
				"1. 🔄 Phone feature to PR [~1 hr]",
				"   1. 🔄 Fix the flaky listener test",
				"2. 🛑 Approve the Wave 6/7 PR batch",
				"3. ✅ Sign in to GitHub",
				"",
				"Total: ~1 hr (critical path: 1 Phone feature to PR)",
				"",
			].join("\n"),
		);
	});

	test("renderPlain uses status words, [x] only for done, and a # Total line", () => {
		const out = renderPlain(sample());
		expect(out).toBe(
			[
				"1. [ ] running: Phone feature to PR [~1 hr]",
				"   1. [ ] running: Fix the flaky listener test",
				"2. [ ] blocked-user: Approve the Wave 6/7 PR batch",
				"3. [x] done: Sign in to GitHub",
				"",
				"# Total: ~1 hr (critical path: 1 Phone feature to PR)",
				"",
			].join("\n"),
		);
	});

	test("renderPlain is pure ASCII even when item text is not", () => {
		const model: ChecklistModel = { open: [item("café ☕")], done: [] };
		const out = renderPlain(model);
		for (const char of out) expect(char.codePointAt(0) ?? 0).toBeLessThan(0x80);
	});

	test("renderLong emits an ASCII POSIX table with ORDER, OWNER and ETA columns and a # Total line", () => {
		const out = renderLong(sample());
		const lines = out.split("\n").filter(Boolean);
		expect(lines[0]).toBe("ORDER\tOWNER\tSTATUS\tWORK\tDETAIL\tPR/MR\tETA");
		expect(lines[1]).toBe("1\tagent\trunning\tPhone feature to PR\t-\t-\t~1 hr");
		expect(lines[2]).toBe("-\tagent\trunning\tFix the flaky listener test\t-\t-\t-");
		expect(lines[3]).toBe("2\tuser\tblocked-user\tApprove the Wave 6/7 PR batch\t-\t-\t-");
		expect(lines[4]).toBe("3\t-\tdone\tSign in to GitHub\t-\t-\t-");
		expect(lines.at(-1)).toBe("# Total: ~1 hr (critical path: 1 Phone feature to PR)");
		for (const line of lines) for (const char of line) expect(char.codePointAt(0) ?? 0).toBeLessThan(0x80);
	});

	test("renderLong gives every sub-item row a dash in ORDER and keeps them in stored order under their parent, even past 10", () => {
		const parent = item("Parent", { status: "running" });
		parent.children = Array.from({ length: 12 }, (_, i) => item(`sub ${i}`));
		const out = renderLong({ open: [parent], done: [] });
		const rows = out.split("\n").filter((line) => line.startsWith("1\t") || line.startsWith("-\t"));
		expect(rows[0]).toBe("1\tagent\trunning\tParent\t-\t-\t-");
		expect(rows.slice(1).map((row) => row.split("\t")[3])).toEqual(
			Array.from({ length: 12 }, (_, i) => `sub ${i}`),
		);
		expect(rows.slice(1).every((row) => row.startsWith("-\tagent\tqueued\t"))).toBe(true);
	});

	test("renderLong sanitizes an embedded tab in item text to a space", () => {
		const out = renderLong({ open: [item("has\ta\ttab")], done: [] });
		expect(out).toContain("has a tab");
	});

	test("every view reports an empty checklist with one line naming how to add items", () => {
		expect(renderEmoji(emptyModel())).toBe('No checklist yet. Add one with: ~/.dg/bin/dg-skills stat add "<text>"\n');
		expect(renderPlain(emptyModel())).toBe('No checklist yet. Add one with: ~/.dg/bin/dg-skills stat add "<text>"\n');
		expect(renderLong(emptyModel())).toBe(
			'ORDER\tOWNER\tSTATUS\tWORK\tDETAIL\tPR/MR\tETA\n# No checklist yet. Add one with: ~/.dg/bin/dg-skills stat add "<text>"\n',
		);
	});

	test("renderJsonModel carries owner, status, order, text, children and a null owner on done items", () => {
		const json = renderJsonModel(sample());
		expect(json.open[0]).toMatchObject({ order: "1", owner: "agent", status: "running", eta: "~1 hr" });
		expect(json.open[0]?.children[0]).toMatchObject({ order: "1.1", owner: "agent" });
		expect(json.done[0]).toMatchObject({ order: "3", owner: null, status: "done", eta: null });
		expect(json.total).toEqual({ bucket: "~1 hr", order: "1", text: "Phone feature to PR" });
	});
});

describe("markDone", () => {
	test("moves a matched top-level item and its children to the front of done", () => {
		const parent = item("Phone feature to PR", { status: "running" });
		parent.children.push(item("sub"));
		const model: ChecklistModel = { open: [parent, item("other")], done: [item("older", { status: "done" })] };
		const result = markDone(model, "Phone feature");
		if (!result.ok) throw new Error("expected a match");
		expect(result.model.open.map((i) => i.text)).toEqual(["other"]);
		expect(result.model.done.map((i) => i.text)).toEqual(["Phone feature to PR", "older"]);
		expect(result.model.done[0]?.children).toHaveLength(1);
		expect(result.model.done[0]?.status).toBe("done");
	});

	test("ticks a matched sub-item in place without moving its still-open parent", () => {
		const parent = item("Parent", { status: "running" });
		parent.children.push(item("sub task"), item("sibling", { status: "queued" }));
		const other = item("other parent");
		const result = markDone({ open: [parent, other], done: [item("kept", { status: "done" })] }, "sub task");
		if (!result.ok) throw new Error("expected a match");
		expect(result.model.open.map((entry) => entry.text)).toEqual(["Parent", "other parent"]);
		expect(result.model.open[0]?.status).toBe("running");
		expect(result.model.open[0]?.children.map((child) => child.status)).toEqual(["done", "queued"]);
		expect(result.model.done.map((entry) => entry.text)).toEqual(["kept"]);
	});

	test("errors with no candidates when nothing matches", () => {
		const result = markDone({ open: [item("alpha")], done: [] }, "zzz");
		expect(result).toEqual({ ok: false, candidates: [] });
	});

	test("errors with every candidate listed when the match is ambiguous", () => {
		const result = markDone({ open: [item("slice 6"), item("slice 6b")], done: [] }, "slice 6");
		expect(result).toEqual({
			ok: false,
			candidates: [
				{ label: "1", text: "slice 6" },
				{ label: "2", text: "slice 6b" },
			],
		});
	});
});

describe("setStatus", () => {
	test("reopens a done top-level item at the end of the open list", () => {
		const model: ChecklistModel = { open: [item("other")], done: [item("Phone feature", { status: "done" })] };
		const result = setStatus(model, "Phone feature", "queued", "~30 min");
		if (!result.ok) throw new Error("expected a match");
		expect(result.model.done).toHaveLength(0);
		expect(result.model.open.map((i) => i.text)).toEqual(["other", "Phone feature"]);
		expect(result.model.open[1]).toMatchObject({ status: "queued", eta: "~30 min" });
	});

	test("mutates a child's status in place without relocating it", () => {
		const parent = item("Parent", { status: "running" });
		parent.children.push(item("sub"), item("sibling"));
		const result = setStatus(
			{ open: [parent, item("other")], done: [item("kept", { status: "done" })] },
			"sub",
			"failed",
		);
		if (!result.ok) throw new Error("expected a match");
		expect(result.model.open.map((entry) => entry.text)).toEqual(["Parent", "other"]);
		expect(result.model.open[0]?.status).toBe("running");
		expect(result.model.open[0]?.children.map((child) => child.status)).toEqual(["failed", "queued"]);
		expect(result.model.done.map((entry) => entry.text)).toEqual(["kept"]);
	});

	test("clears eta when moving an item to done", () => {
		const model: ChecklistModel = { open: [item("x", { eta: "~1 hr" })], done: [] };
		const result = setStatus(model, "x", "done");
		if (!result.ok) throw new Error("expected a match");
		expect(result.model.done[0]).toMatchObject({ status: "done", eta: undefined });
	});
});

describe("addItem", () => {
	test("defaults to queued and appends at the end", () => {
		const result = addItem({ open: [item("a")], done: [] }, "b");
		if (!result.ok) throw new Error("expected success");
		expect(result.model.open.map((i) => i.text)).toEqual(["a", "b"]);
		expect(result.model.open[1]).toMatchObject({ status: "queued" });
		expect(result.label).toBe("2");
	});

	test("--at inserts at a 1-based position, clamped to the open list's length", () => {
		const result = addItem({ open: [item("a"), item("b")], done: [] }, "first", { at: 1 });
		if (!result.ok) throw new Error("expected success");
		expect(result.model.open.map((i) => i.text)).toEqual(["first", "a", "b"]);
		const overshoot = addItem({ open: [item("a")], done: [] }, "last", { at: 99 });
		if (!overshoot.ok) throw new Error("expected success");
		expect(overshoot.model.open.map((i) => i.text)).toEqual(["a", "last"]);
	});

	test("--under <n> adds a sub-item under the open top-level item at that position", () => {
		const result = addItem({ open: [item("parent")], done: [] }, "child", { under: "1" });
		if (!result.ok) throw new Error("expected success");
		expect(result.model.open[0]?.children.map((c) => c.text)).toEqual(["child"]);
		expect(result.label).toBe("1.1");
	});

	test("--under <match> resolves by text and errors when ambiguous", () => {
		const ambiguous = addItem({ open: [item("slice 6"), item("slice 6b")], done: [] }, "child", {
			under: "slice 6",
		});
		expect(ambiguous).toEqual({
			ok: false,
			candidates: [
				{ label: "1", text: "slice 6" },
				{ label: "2", text: "slice 6b" },
			],
		});
	});

	test("sanitizes embedded newlines and tabs in the new item's text", () => {
		const result = addItem(emptyModel(), "line one\nline\ttwo");
		if (!result.ok) throw new Error("expected success");
		expect(result.model.open[0]?.text).toBe("line one line two");
	});
});

describe("markDone matches by the item's own status", () => {
	test("marks an unfinished child of a done parent in place", () => {
		const parent = item("parent", { status: "done" });
		parent.children.push(
			item("child task", { status: "running", eta: "~15 min" }),
			item("sibling", { status: "queued" }),
		);
		const result = markDone(
			{ open: [item("still open")], done: [parent, item("other done", { status: "done" })] },
			"child task",
		);
		if (!result.ok) throw new Error(`expected a match, got ${JSON.stringify(result)}`);
		expect(result.label).toBe("2.1");
		expect(result.model.open.map((entry) => entry.text)).toEqual(["still open"]);
		expect(result.model.done.map((entry) => entry.text)).toEqual(["parent", "other done"]);
		expect(result.model.done[0]?.status).toBe("done");
		expect(result.model.done[0]?.children[0]).toMatchObject({ status: "done", eta: undefined });
		expect(result.model.done[0]?.children[1]?.status).toBe("queued");
	});

	test("stays ambiguous when two unfinished children of a done parent share the match", () => {
		const parent = item("parent", { status: "done" });
		parent.children.push(item("slice 6", { status: "running" }), item("slice 6b", { status: "queued" }));
		const result = markDone({ open: [], done: [parent] }, "slice 6");
		expect(result).toEqual({
			ok: false,
			candidates: [
				{ label: "1.1", text: "slice 6" },
				{ label: "1.2", text: "slice 6b" },
			],
		});
	});

	test("does not let an already-done child under an open parent make another match ambiguous", () => {
		const parent = item("alpha parent", { status: "running" });
		parent.children.push(item("alpha child", { status: "done" }));
		const result = markDone({ open: [parent], done: [] }, "alpha");
		if (!result.ok) throw new Error(`expected a match, got ${JSON.stringify(result)}`);
		expect(result.model.open).toHaveLength(0);
		expect(result.model.done[0]?.text).toBe("alpha parent");
		expect(result.model.done[0]?.children[0]?.status).toBe("done");
	});
});

describe("setStatus reaches children of done parents", () => {
	test("updates an unfinished child of a done parent without moving it", () => {
		const parent = item("parent", { status: "done" });
		parent.children.push(item("child task", { status: "running" }), item("sibling"));
		const result = setStatus(
			{ open: [item("still open")], done: [parent, item("other done", { status: "done" })] },
			"child task",
			"queued",
			"~15 min",
		);
		if (!result.ok) throw new Error(`expected a match, got ${JSON.stringify(result)}`);
		expect(result.label).toBe("2.1");
		expect(result.model.open.map((entry) => entry.text)).toEqual(["still open"]);
		expect(result.model.done.map((entry) => entry.text)).toEqual(["parent", "other done"]);
		expect(result.model.done[0]?.status).toBe("done");
		expect(result.model.done[0]?.children[0]).toMatchObject({ status: "queued", eta: "~15 min" });
		expect(result.model.done[0]?.children[1]?.status).toBe("queued");
	});
});

describe("done display cap keeps unfinished subtrees", () => {
	test("keeps a done parent with an unfinished child past the cap and counts only omitted subtrees", () => {
		const done = Array.from({ length: 12 }, (_, i) => item(`done ${i}`, { status: "done" as const }));
		done[11]!.children.push(item("still running", { status: "running", eta: "~30 min" }));
		const model: ChecklistModel = { open: [], done };
		const { rows, hiddenDoneCount } = flattenForDisplay(model, 10);
		expect(rows.map((row) => row.text)).toContain("done 11");
		expect(rows.find((row) => row.text === "done 11")?.order).toBe("12");
		expect(rows.find((row) => row.text === "still running")?.order).toBe("12.1");
		expect(rows.map((row) => row.text)).not.toContain("done 10");
		expect(hiddenDoneCount).toBe(1);
		expect(renderEmoji(model)).toContain("still running");
		expect(renderEmoji(model)).toContain("...and 1 more done");
		expect(renderPlain(model)).toContain("still running");
		expect(renderPlain(model)).toContain("...and 1 more done");
		expect(renderLong(model)).toContain("still running");
		expect(renderLong(model)).toContain("# ...and 1 more done");
	});

	test("omits the more-done line when every past-cap parent still has unfinished work", () => {
		const done = Array.from({ length: 11 }, (_, i) => item(`done ${i}`, { status: "done" as const }));
		done[10]!.children.push(item("live", { status: "running" }));
		const model: ChecklistModel = { open: [], done };
		expect(flattenForDisplay(model, 10).hiddenDoneCount).toBe(0);
		expect(renderEmoji(model)).not.toContain("more done");
		expect(renderPlain(model)).not.toContain("more done");
		expect(renderLong(model)).not.toContain("more done");
		expect(renderEmoji(model)).toContain("live");
	});

	test("hides a fully finished past-cap subtree, including its done children, without hiding an open item at the same index", () => {
		const open = Array.from({ length: 11 }, (_, i) => item(`open ${i}`));
		const done = Array.from({ length: 11 }, (_, i) => item(`done ${i}`, { status: "done" as const }));
		done[10]!.children.push(item("finished child", { status: "done" }));
		const { rows, hiddenDoneCount } = flattenForDisplay({ open, done }, 10);
		expect(hiddenDoneCount).toBe(1);
		expect(rows.map((row) => row.text)).toContain("open 10");
		expect(rows.map((row) => row.text)).not.toContain("done 10");
		expect(rows.map((row) => row.text)).not.toContain("finished child");
	});
});

describe("computeTotal includes unfinished children and excludes parked work", () => {
	test("a sub-item with a larger eta sets the critical path, including under a done parent", () => {
		const parent = item("parent", { status: "running", eta: "~15 min" });
		parent.children.push(item("child", { status: "running", eta: "~1 hr" }));
		expect(computeTotal({ open: [parent], done: [] })).toEqual({
			bucket: "~1 hr",
			label: { order: "1.1", text: "child" },
		});

		const doneParent = item("done parent", { status: "done" });
		doneParent.children.push(item("still", { status: "running", eta: ">1 hr" }));
		expect(computeTotal({ open: [item("small", { eta: "<5 min" })], done: [doneParent] })).toEqual({
			bucket: ">1 hr",
			label: { order: "2.1", text: "still" },
		});
		expect(computeTotal({ open: [], done: [doneParent] })).toEqual({
			bucket: ">1 hr",
			label: { order: "1.1", text: "still" },
		});
	});

	test("an equal child eta does not replace an earlier parent on the critical path", () => {
		const parent = item("parent", { status: "running", eta: "~1 hr" });
		parent.children.push(item("child", { status: "running", eta: "~1 hr" }));
		expect(computeTotal({ open: [parent], done: [] })).toEqual({
			bucket: "~1 hr",
			label: { order: "1", text: "parent" },
		});
	});

	test("a parked eta does not set the critical path, even as the only open item or as a child", () => {
		expect(
			computeTotal({ open: [item("paused", { status: "parked", eta: ">1 hr" })], done: [] }),
		).toEqual({ bucket: "unknown" });
		const parent = item("parent", { status: "running" });
		parent.children.push(item("paused child", { status: "parked", eta: ">1 hr" }));
		expect(computeTotal({ open: [parent], done: [] })).toEqual({ bucket: "unknown" });
		const queued = item("queued big", { eta: ">1 hr" });
		const parked = item("parked bigger", { status: "parked", eta: ">1 hr" });
		expect(computeTotal({ open: [item("running small", { status: "running", eta: "<5 min" }), queued, parked], done: [] })).toEqual({
			bucket: ">1 hr",
			label: { order: "2", text: "queued big" },
		});
	});

	test("an unknown eta does not become a labeled critical path", () => {
		expect(computeTotal({ open: [item("x", { eta: "unknown" })], done: [] })).toEqual({ bucket: "unknown" });
	});

	test("a user item with a larger eta does not beat an agent item", () => {
		expect(
			computeTotal({
				open: [
					item("agent", { eta: "~15 min" }),
					item("user", { status: "needs-user", eta: ">1 hr" }),
				],
				done: [],
			}),
		).toEqual({ bucket: "~15 min", label: { order: "1", text: "agent" } });
	});
});

describe("plain indent follows the parent number width", () => {
	function withChildAt(count: number): ChecklistModel {
		const open = Array.from({ length: count - 1 }, (_, i) => item(`item ${i + 1}`));
		const parent = item("parent");
		parent.children.push(item("nested"));
		open.push(parent);
		return { open, done: [] };
	}

	test("serializes and renders a child of item 10 with 4 spaces and item 100 with 5, and still parses a legacy 3-space indent", () => {
		const ten = withChildAt(10);
		const serialized = serializeChecklist(ten);
		expect(serialized).toContain("\n    1. [ ] queued: nested\n");
		expect(parseChecklist(serialized)).toEqual(ten);
		expect(renderPlain(ten)).toContain("\n    1. [ ] queued: nested\n");

		const hundred = withChildAt(100);
		expect(serializeChecklist(hundred)).toContain("\n     1. [ ] queued: nested\n");
		expect(parseChecklist(serializeChecklist(hundred))).toEqual(hundred);

		const legacy = ["10. [ ] queued: parent", "   1. [ ] queued: legacy child", ""].join("\n");
		expect(parseChecklist(legacy).open[0]?.children.map((child) => child.text)).toEqual(["legacy child"]);

		const orphan = ["   1. [ ] queued: orphan", "1. [ ] queued: parent", ""].join("\n");
		const parsed = parseChecklist(orphan);
		expect(parsed.open.map((entry) => entry.text)).toEqual(["parent"]);
		expect(parsed.open[0]?.children).toEqual([]);
	});
});

describe("eta suffix collisions", () => {
	test("round-trips text that ends in an eta bucket without inventing an eta", () => {
		for (const bucket of ["<5 min", "~15 min", "~30 min", "~1 hr", ">1 hr", "unknown"] as const) {
			const text = `Investigate [${bucket}]`;
			const openModel: ChecklistModel = { open: [item(text)], done: [] };
			expect(parseChecklist(serializeChecklist(openModel))).toEqual(openModel);
			const doneModel: ChecklistModel = { open: [], done: [item(text, { status: "done" })] };
			expect(parseChecklist(serializeChecklist(doneModel))).toEqual(doneModel);
		}
	});

	test("keeps a real eta when the text itself ends in a bucket", () => {
		const model: ChecklistModel = {
			open: [item("Investigate [unknown]", { eta: "~15 min" })],
			done: [],
		};
		const raw = serializeChecklist(model);
		expect(raw).toContain("\\[unknown]");
		expect(raw).toContain("[~15 min]");
		expect(parseChecklist(raw)).toEqual(model);
	});

	test("round-trips a literal backslash before a bucket and a trailing backslash before a real eta", () => {
		const literal: ChecklistModel = { open: [item("Investigate \\[unknown]")], done: [] };
		expect(parseChecklist(serializeChecklist(literal))).toEqual(literal);
		const trailing: ChecklistModel = { open: [item("foo \\", { eta: "~1 hr" })], done: [] };
		expect(parseChecklist(serializeChecklist(trailing))).toEqual(trailing);
		const middle: ChecklistModel = { open: [item("see [unknown] notes")], done: [] };
		expect(serializeChecklist(middle)).toContain("see [unknown] notes");
		expect(parseChecklist(serializeChecklist(middle))).toEqual(middle);
		const brackets: ChecklistModel = { open: [item("see [notes]")], done: [] };
		expect(serializeChecklist(brackets)).toContain("see [notes]");
		expect(serializeChecklist(brackets)).not.toContain("\\[");
		expect(parseChecklist(serializeChecklist(brackets))).toEqual(brackets);
		const earlier: ChecklistModel = { open: [item("see [notes] then [unknown]")], done: [] };
		expect(serializeChecklist(earlier)).toContain("see [notes] then \\[unknown]");
		expect(parseChecklist(serializeChecklist(earlier))).toEqual(earlier);
	});

	test("does not write an eta suffix onto a done item", () => {
		const model: ChecklistModel = { open: [], done: [item("finished", { status: "done", eta: "~1 hr" })] };
		const raw = serializeChecklist(model);
		expect(raw).not.toContain("[~1 hr]");
		expect(parseChecklist(raw).done[0]).toMatchObject({ text: "finished", status: "done", eta: undefined });
	});
});

describe("renderLong total line is ASCII", () => {
	test("folds non-ASCII and tabs in the critical-path text the same way as a row", () => {
		const model: ChecklistModel = {
			open: [item("café\tbomb", { status: "running", eta: "~15 min" })],
			done: [],
		};
		const out = renderLong(model);
		for (const char of out) expect(char.codePointAt(0) ?? 0).toBeLessThan(0x80);
		const total = out.split("\n").find((line) => line.startsWith("# Total"));
		expect(total).toBe("# Total: ~15 min (critical path: 1 caf? bomb)");
		expect(total?.includes("\t")).toBe(false);
		expect(renderEmoji(model)).toContain("café");
	});
});
