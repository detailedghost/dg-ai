import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addSection,
	addVariant,
	chains,
	dropPending,
	formatStatus,
	mergeVerdicts,
	readBoard,
	readVerdicts,
	resolveSessionDir,
	reworkChains,
	setPending,
	statusReport,
	verdictLabel,
	verifyPaths,
	writeBoard,
	type Board,
	type Section,
	type Verdict,
} from "../src/verify/board";

let dir = "";

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

function section(id: string, extra: Partial<Section> = {}): Section {
	return { id, title: id.replace(/-r\d+$/, ""), images: [{ label: "desktop · a", before: "missing", after: "/shots/a.png" }], ...extra };
}

function verdict(status: Verdict["status"], note = ""): Verdict {
	return { status, note, at: "2026-10-28T00:00:00.000Z" };
}

const board = (sections: Section[], pending: Board["pending"] = []): Board => ({ name: "review", sections, pending });

describe("chains", () => {
	test("links rounds by follows and attaches the pending next round", () => {
		const b = board(
			[section("home-r1"), section("settings-r1"), section("home-r2", { follows: "home-r1", round: 2 })],
			[{ key: "home-r3", title: "Home", follows: "home-r2" }],
		);
		const result = chains(b);
		expect(result.map((chain) => chain.rounds.map((round) => round.id))).toEqual([["home-r1", "home-r2"], ["settings-r1"]]);
		expect(result[0]?.waiting?.key).toBe("home-r3");
		expect(result[1]?.waiting).toBeUndefined();
	});

	test("treats a round whose parent is missing as a new chain", () => {
		expect(chains(board([section("a-r2", { follows: "gone" })])).map((chain) => chain.last.id)).toEqual(["a-r2"]);
	});
});

describe("status", () => {
	test("is all approved only when every chain ends in a plain approve and nothing is pending", () => {
		const b = board([section("home-r1"), section("home-r2", { follows: "home-r1" })]);
		const approved = { "home-r1": verdict("approved", "tighten the gap"), "home-r2": verdict("approved") };
		expect(statusReport(b, approved).allApproved).toBe(true);
		expect(statusReport(b, { ...approved, "home-r2": verdict("approved", "one more") }).allApproved).toBe(false);
		expect(statusReport(setPending(b, { key: "new", title: "New" }), approved).allApproved).toBe(false);
		expect(statusReport(board([]), {}).allApproved).toBe(false);
	});

	test("is reviewed once every round has any verdict", () => {
		const b = board([section("a-r1"), section("b-r1")]);
		expect(statusReport(b, { "a-r1": verdict("skip") }).reviewed).toBe(false);
		expect(statusReport(b, { "a-r1": verdict("skip"), "b-r1": verdict("changes", "redo") }).reviewed).toBe(true);
		expect(statusReport(board([]), {}).reviewed).toBe(false);
	});

	test("prints one line per item with rounds, the latest note, and the open count", () => {
		const b = board(
			[section("home-r1"), section("home-r2", { follows: "home-r1", round: 2 }), section("nav-r1")],
			[{ key: "home-r3", title: "Home", follows: "home-r2" }, { key: "forms", title: "Forms" }],
		);
		const text = formatStatus(
			statusReport(b, { "home-r1": verdict("changes", "x".repeat(200)), "home-r2": verdict("approved", "nudge"), "nav-r1": verdict("approved") }),
			false,
		);
		expect(text.split("\n")).toEqual([
			"· home | r1 sent back → r2 approved+note → r3 working | nudge",
			"✓ nav | r1 approved",
			"· Forms | r1 working",
			"2 open",
			"",
		]);
		const clipped = formatStatus(statusReport(board([section("a-r1")]), { "a-r1": verdict("changes", "y".repeat(200)) }), false);
		expect(clipped).toContain(`${"y".repeat(159)}…`);
		expect(formatStatus(statusReport(board([section("a-r1")]), { "a-r1": verdict("approved") }), false)).toBe("✓ a | r1 approved\nALL APPROVED\n");
		expect(JSON.parse(formatStatus(statusReport(b, {}), true)).items).toHaveLength(3);
	});

	test("labels each verdict", () => {
		const picked = { ...verdict("approved"), variant: "C" };
		expect(
			[undefined, verdict("approved"), verdict("approved", "n"), verdict("changes", "n"), verdict("skip"), picked, { ...picked, note: "n" }].map(
				verdictLabel,
			),
		).toEqual(["unreviewed", "approved", "approved+note", "sent back", "skipped", "picked C", "picked C+note"]);
	});
});

describe("rounds and pending", () => {
	test("adding a round replaces the same id and clears the pending entry it fulfills", () => {
		let b = setPending(board([section("home-r1")]), { key: "home-r2", title: "Home", follows: "home-r1" });
		b = setPending(b, { key: "other", title: "Other" });
		b = addSection(b, section("home-r2", { follows: "home-r1" }));
		expect(b.pending.map((entry) => entry.key)).toEqual(["other"]);
		b = addSection(b, section("other-r1"), "other");
		expect(b.pending).toEqual([]);
		b = addSection(b, section("home-r2", { follows: "home-r1", summary: "new" }));
		expect(b.sections.filter((entry) => entry.id === "home-r2").map((entry) => entry.summary)).toEqual(["new"]);
		expect(() => addSection(b, section("x-r2", { follows: "missing" }))).toThrow("follows missing not found");
		expect(dropPending(setPending(b, { key: "k", title: "K" }), "k").pending).toEqual([]);
	});

	test("versions merge into one round, stay sorted, and clear only the named pending entry", () => {
		let b = setPending(board([section("nav-r1")]), { key: "nav-r2", title: "Nav", follows: "nav-r1" });
		b = setPending(b, { key: "nav-v", title: "Nav" });
		const round = { id: "nav-r2", title: "Nav", follows: "nav-r1" };
		const shot = (after: string) => [{ label: "desktop · a", before: "missing", after }];
		b = addVariant(b, round, { key: "B", label: "Rail", images: shot("/b.png") });
		expect(b.pending.map((entry) => entry.key)).toEqual(["nav-r2", "nav-v"]);
		b = addVariant(b, round, { key: "A", images: shot("/a.png") }, "nav-v");
		b = addVariant(b, round, { key: "B", images: shot("/b2.png") }, "nav-r2");
		const nav = b.sections.find((entry) => entry.id === "nav-r2");
		expect(nav?.images).toEqual([]);
		expect(nav?.variants?.map((entry) => [entry.key, entry.images[0]?.after])).toEqual([
			["A", "/a.png"],
			["B", "/b2.png"],
		]);
		expect(b.pending).toEqual([]);
		expect(() => addVariant(b, round, { key: "B:1", images: [] })).toThrow("invalid variant");
		expect(() => addVariant(b, { ...round, follows: "gone" }, { key: "C", images: [] })).toThrow("follows gone not found");
	});

	test("rework picks rounds sent back or approved with a note that have no next round", () => {
		const b = board(
			[section("a-r1"), section("b-r1"), section("c-r1"), section("d-r1"), section("e-r1")],
			[{ key: "e-r2", title: "e", follows: "e-r1" }],
		);
		const picks = reworkChains(b, {
			"a-r1": verdict("changes", "redo"),
			"b-r1": verdict("approved", "nudge"),
			"c-r1": verdict("approved"),
			"d-r1": verdict("skip"),
			"e-r1": verdict("changes", "redo"),
		});
		expect(picks.map((chain) => chain.last.id)).toEqual(["a-r1", "b-r1"]);
	});
});

describe("files", () => {
	test("an empty session reads as an empty board and the board round-trips", () => {
		dir = mkdtempSync(join(tmpdir(), "dg-verify-board-"));
		const paths = verifyPaths(dir);
		expect(readBoard(paths, "review")).toEqual({ name: "review", sections: [], pending: [] });
		expect(readVerdicts(paths)).toEqual({});
		writeBoard(paths, board([section("a-r1")]));
		expect(readBoard(paths, "review").sections.map((entry) => entry.id)).toEqual(["a-r1"]);
	});

	test("merging verdicts validates status, note, and section", () => {
		dir = mkdtempSync(join(tmpdir(), "dg-verify-board-"));
		const paths = verifyPaths(dir);
		const b = board([section("a-r1"), section("b-r1")]);
		mergeVerdicts(paths, b, { "a-r1": { status: "approved", note: "  tidy  " } }, "t1");
		mergeVerdicts(paths, b, { "b-r1": { status: "skip" } }, "t2");
		expect(readVerdicts(paths)).toEqual({
			"a-r1": { status: "approved", note: "tidy", at: "t1" },
			"b-r1": { status: "skip", note: "", at: "t2" },
		});
		expect(() => mergeVerdicts(paths, b, { "a-r1": { status: "changes", note: " " } })).toThrow("a note is required");
		expect(() => mergeVerdicts(paths, b, { "a-r1": { status: "reject", note: "n" } })).toThrow("status must be");
		expect(() => mergeVerdicts(paths, b, { "zz-r1": { status: "skip" } })).toThrow("unknown section");
		expect(() => mergeVerdicts(paths, b, { "a-r1": { status: "approved", note: "n".repeat(4001) } })).toThrow("at most 4000");
		expect(() => mergeVerdicts(paths, b, [])).toThrow("Invalid JSON");
	});

	test("a picked version is stored only with approve and only when the round has it", () => {
		dir = mkdtempSync(join(tmpdir(), "dg-verify-board-"));
		const paths = verifyPaths(dir);
		const versions = [{ key: "A", images: [] }, { key: "B", images: [] }];
		const b = board([section("nav-r1", { images: [], variants: versions }), section("x-r1")]);
		mergeVerdicts(paths, b, { "nav-r1": { status: "approved", note: "", variant: "B" } }, "t1");
		expect(readVerdicts(paths)["nav-r1"]).toEqual({ status: "approved", note: "", at: "t1", variant: "B" });
		expect(() => mergeVerdicts(paths, b, { "nav-r1": { status: "approved", note: "", variant: "C" } })).toThrow("variant must");
		expect(() => mergeVerdicts(paths, b, { "nav-r1": { status: "skip", note: "", variant: "A" } })).toThrow("variant must");
		expect(() => mergeVerdicts(paths, b, { "x-r1": { status: "approved", note: "", variant: "A" } })).toThrow("variant must");
		expect(statusReport(b, readVerdicts(paths)).items[0]?.rounds).toEqual(["r1 picked B"]);
	});

	test("a corrupt verdict file throws instead of reading as empty", () => {
		dir = mkdtempSync(join(tmpdir(), "dg-verify-board-"));
		const paths = verifyPaths(dir);
		writeFileSync(paths.verdicts, JSON.stringify({ _updated: "x", "a-r1": { status: "maybe", note: "" } }));
		expect(() => readVerdicts(paths)).toThrow("verdict for a-r1 is incomplete");
		writeFileSync(paths.board, "[]");
		expect(() => readBoard(paths, "review")).toThrow("board.json must be an object");
	});

	test("the default session lives under .agents/verify and a path-like name is refused", () => {
		expect(resolveSessionDir("review", "/repo")).toBe("/repo/.agents/verify/review");
		expect(resolveSessionDir("review", "/repo", "/tmp/s")).toBe("/tmp/s");
		expect(() => resolveSessionDir("../x", "/repo")).toThrow("invalid verify name");
	});
});
