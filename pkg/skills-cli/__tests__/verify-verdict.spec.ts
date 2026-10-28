import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "../src/verify/manifest";
import {
	applyDecision,
	assertDecision,
	buildVerdict,
	claimVerdict,
	forgetItems,
	formatStatus,
	publishVerdict,
	readDecisions,
	reworkIds,
	statusReport,
	summarize,
	verifyPaths,
	writeReload,
	bumpReload,
} from "../src/verify/verdict";

const manifest = parseManifest({
	name: "review",
	stackUrl: "http://127.0.0.1:1/",
	items: [
		{
			id: "home",
			title: "Home",
			owner: "dg:implementer",
			beforeUrl: "http://127.0.0.1:2/",
			afterUrl: "http://127.0.0.1:3/",
			roles: [{ id: "admin" }],
		},
		{
			id: "settings",
			title: "Settings",
			owner: "bc-owner",
			beforeUrl: "http://127.0.0.1:2/settings",
			afterUrl: "http://127.0.0.1:3/settings",
			roles: [{ id: "member" }],
		},
	],
});

describe("decision rules", () => {
	test("approve may omit a note and reject or tweak may not", () => {
		expect(assertDecision("approve", "  ")).toEqual({ action: "approve", note: "" });
		expect(assertDecision("tweak", " tighten ")).toEqual({ action: "tweak", note: "tighten" });
		expect(() => assertDecision("reject", " ")).toThrow(/note is required/);
		expect(() => assertDecision("tweak", "")).toThrow(/note is required/);
		expect(() => assertDecision("ship", "ok")).toThrow(/approve, reject, or tweak/);
		expect(() => assertDecision("approve", "x".repeat(4001))).toThrow(/4000/);
		expect(assertDecision("approve", "x".repeat(4000)).note).toHaveLength(4000);
	});

	test("pending stays pending until every item is approved", () => {
		expect(summarize(["home", "settings"], {})).toEqual({
			status: "pending",
			allApproved: false,
			pending: ["home", "settings"],
		});
		const one = summarize(["home", "settings"], {
			home: { action: "approve", note: "", at: "t" },
		});
		expect(one.status).toBe("pending");
		expect(one.allApproved).toBe(false);
		expect(
			summarize(["home", "settings"], {
				home: { action: "approve", note: "", at: "t" },
				settings: { action: "approve", note: "", at: "t" },
			}).allApproved,
		).toBe(true);
		expect(
			summarize(["home"], {
				home: { action: "tweak", note: "pad", at: "t" },
			}).status,
		).toBe("needs-rework");
	});

	test("rework ids are only reject and tweak", () => {
		expect(
			reworkIds({
				home: { action: "approve", note: "", at: "t" },
				settings: { action: "reject", note: "clip", at: "t" },
				nav: { action: "tweak", note: "gap", at: "t" },
			}),
		).toEqual(["settings", "nav"]);
	});
});

describe("verdict files", () => {
	test("publishes one verdict, claims it, and status stays readable", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-verdict-"));
		const paths = verifyPaths(dir);
		try {
			applyDecision(paths, manifest, "home", "approve", "", "2026-10-28T00:00:00.000Z");
			expect(publishVerdict(paths, manifest)).toBeUndefined();
			expect(statusReport(paths, manifest).status).toBe("pending");
			applyDecision(paths, manifest, "settings", "tweak", "The menu clips", "2026-10-28T00:00:01.000Z");
			const verdict = buildVerdict(manifest, readDecisions(paths));
			expect(verdict.allApproved).toBe(false);
			expect(verdict.status).toBe("needs-rework");
			expect(verdict.notifications).toEqual([
				{ itemId: "settings", owner: "bc-owner", action: "tweak", note: "The menu clips" },
			]);
			const claimed = claimVerdict(paths);
			expect(claimed?.items.settings?.owner).toBe("bc-owner");
			expect(claimVerdict(paths)?.status).toBe("needs-rework");
			const report = statusReport(paths, manifest);
			expect(report.claimed).toBe(true);
			expect(report.allApproved).toBe(false);
			expect(formatStatus(report, false)).toBe(
				[
					"needs-rework",
					"home approve owner=dg:implementer",
					"settings tweak owner=bc-owner",
					"The menu clips",
					"allApproved false",
					"claimed true",
					"",
				].join("\n"),
			);
			expect(() => applyDecision(paths, manifest, "home", "reject", "nope")).toThrow(/already claimed/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("forgetting a tweaked item clears its note and the claim", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-forget-"));
		const paths = verifyPaths(dir);
		try {
			applyDecision(paths, manifest, "home", "approve", "");
			applyDecision(paths, manifest, "settings", "reject", "clip");
			claimVerdict(paths);
			forgetItems(paths, ["settings"]);
			const report = statusReport(paths, manifest);
			expect(report.items.settings?.action).toBe("pending");
			expect(report.items.home?.action).toBe("approve");
			expect(report.notifications).toEqual([]);
			expect(report.claimed).toBe(false);
			expect(report.status).toBe("pending");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an approve replaces a tweak note", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-replace-"));
		const paths = verifyPaths(dir);
		try {
			applyDecision(paths, manifest, "home", "tweak", "pad");
			applyDecision(paths, manifest, "home", "approve", "");
			expect(statusReport(paths, manifest).notifications).toEqual([]);
			expect(statusReport(paths, manifest).items.home?.action).toBe("approve");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reload tokens start at 1 and then increment", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-reload-"));
		const paths = verifyPaths(dir);
		try {
			expect(writeReload(paths, 1)).toBe("1");
			expect(bumpReload(paths)).toBe("2");
			expect(bumpReload(paths)).toBe("3");
			expect(() => writeReload(paths, 0)).toThrow(/positive/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a corrupt decisions file throws instead of looking empty", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-verify-bad-"));
		const paths = verifyPaths(dir);
		try {
			writeReload(paths, 1);
			Bun.write(paths.decisions, "{");
			expect(() => readDecisions(paths)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
