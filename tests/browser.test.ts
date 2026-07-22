import { expect, test } from "bun:test";
import {
	readDemoScript,
	stripDemoMarker,
} from "../extension-src/utils/demo-marker";
import {
	readGroupMarker,
	readGroupPos,
	stripGroupMarker,
} from "../extension-src/utils/marker";
import { addDemoMarker } from "../skills/browser/bin/utils/demo-marker";
import { versionGte } from "../skills/browser/bin/utils/lib";
import { addGroupMarker } from "../skills/browser/bin/utils/marker";
import {
	extractScriptFromMarkdown,
	toPlanMarkdown,
	validate,
} from "../skills/browser/bin/utils/plan-format";
import { resolveRef } from "../skills/browser/bin/utils/refs";

// --- ref resolution ---

test("full URL passes through unchanged", () => {
	const url = "https://github.com/owner/repo/pull/123";
	expect(resolveRef(url, {}, undefined)).toBe(url);
});

test("owner/repo#num resolves to GitHub pull URL", () => {
	expect(resolveRef("owner/repo#123", {}, undefined)).toBe(
		"https://github.com/owner/repo/pull/123",
	);
});

test("config alias resolves to its pull URL", () => {
	expect(
		resolveRef(
			"work#1517",
			{ aliases: { work: "your-org/your-repo" } },
			undefined,
		),
	).toBe("https://github.com/your-org/your-repo/pull/1517");
});

test("bare number resolves via cfg.defaultRepo when no --repo arg", () => {
	expect(resolveRef("1518", { defaultRepo: "owner/repo" }, undefined)).toBe(
		"https://github.com/owner/repo/pull/1518",
	);
});

test("bare number without default repo throws", () => {
	expect(() => resolveRef("1518", {}, undefined)).toThrow();
});

// --- version comparison (installer idempotency) ---

test("versionGte compares semver correctly", () => {
	expect(versionGte("1.0.0", "1.0.0")).toBe(true);
	expect(versionGte("1.2.0", "1.1.9")).toBe(true);
	expect(versionGte("1.0.0", "1.0.1")).toBe(false);
});

// --- _tab_group marker round-trip (CLI adds → extension reads → extension strips) ---

test("CLI adds a marker the extension reads back", () => {
	const marked = addGroupMarker("https://github.com/o/r/pull/1", "My PRs");
	expect(marked).toBe("https://github.com/o/r/pull/1#_tab_group=My%20PRs");
	expect(readGroupMarker(marked)).toBe("My PRs");
});

test("stripping the marker restores the original URL", () => {
	const url = "https://github.com/o/r/pull/1";
	expect(stripGroupMarker(addGroupMarker(url, "PRs"))).toBe(url);
});

test("marker is appended to an existing fragment and stripped back to it", () => {
	const marked = addGroupMarker("https://github.com/o/r/pull/1#files", "PRs");
	expect(readGroupMarker(marked)).toBe("PRs");
	expect(stripGroupMarker(marked)).toBe("https://github.com/o/r/pull/1#files");
});

test("no marker → readGroupMarker undefined, strip is a no-op", () => {
	const url = "https://github.com/o/r/pull/1";
	expect(readGroupMarker(url)).toBeUndefined();
	expect(stripGroupMarker(url)).toBe(url);
});

// --- _tab_group_pos (batch order) round-trip ---

test("CLI encodes a position the extension reads back, and strips both keys", () => {
	const url = "https://github.com/o/r/pull/1";
	const marked = addGroupMarker(url, "PRs", 2);
	expect(readGroupMarker(marked)).toBe("PRs");
	expect(readGroupPos(marked)).toBe(2);
	expect(stripGroupMarker(marked)).toBe(url);
});

test("no position → readGroupPos undefined", () => {
	expect(
		readGroupPos(addGroupMarker("https://x.test/", "PRs")),
	).toBeUndefined();
});

// --- _demo marker round-trip (CLI encodes → extension decodes → strips) ---

const SCRIPT = {
	title: "Saved filters",
	startUrl: "http://localhost:4200/dashboard",
	steps: [
		{ selector: "#save", title: "Save", body: "Persist the filter — café ☕." },
		{ body: "All done.", advance: 1200 },
	],
};

test("CLI encodes a demo script the extension reads back (UTF-8 safe)", () => {
	const marked = addDemoMarker(SCRIPT.startUrl, SCRIPT);
	expect(marked.startsWith(`${SCRIPT.startUrl}#_demo=`)).toBe(true);
	expect(readDemoScript(marked)).toEqual(SCRIPT);
});

test("stripping the demo marker restores the original URL", () => {
	const marked = addDemoMarker(SCRIPT.startUrl, SCRIPT);
	expect(stripDemoMarker(marked)).toBe(SCRIPT.startUrl);
});

test("demo marker appended to an existing fragment is stripped back to it", () => {
	const marked = addDemoMarker(`${SCRIPT.startUrl}#section`, SCRIPT);
	expect(readDemoScript(marked)).toEqual(SCRIPT);
	expect(stripDemoMarker(marked)).toBe(`${SCRIPT.startUrl}#section`);
});

test("no demo marker → readDemoScript undefined, strip is a no-op", () => {
	const url = "http://localhost:4200/dashboard";
	expect(readDemoScript(url)).toBeUndefined();
	expect(stripDemoMarker(url)).toBe(url);
});

// --- plan.md round-trip (demo writes a plan → rerun extracts + validates it) ---

test("plan markdown embeds a script rerun can extract and validate", () => {
	const md = toPlanMarkdown(validate(SCRIPT));
	expect(md).toContain("# Demo plan: Saved filters");
	expect(validate(extractScriptFromMarkdown(md))).toEqual(SCRIPT);
});

test("a plan file with no json block is rejected", () => {
	expect(() => extractScriptFromMarkdown("# just prose, no code")).toThrow();
});
