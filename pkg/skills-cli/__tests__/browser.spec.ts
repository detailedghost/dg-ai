import { expect, test } from "bun:test";
import {
	readDemoScript,
	readEditFlag,
	stripDemoMarker,
} from "../../extension/utils/demo-marker";
import {
	readGroupMarker,
	readGroupPos,
	stripGroupMarker,
} from "../../extension/utils/marker";
import { addDemoMarker } from "../src/utils/demo-marker";
import { versionGte } from "../src/utils/lib";
import { addGroupMarker } from "../src/utils/marker";
import {
	extractScriptFromMarkdown,
	parsePlanMarkdown,
	toPlanMarkdown,
	validate,
} from "../src/utils/plan-format";
import { resolveRef } from "../src/utils/refs";

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

// Reserved `.example` host (RFC 6761, never resolves) + a distinctive real query
// param — can't hit a live site, and proves markers leave a legit `?…` untouched.
const SCRIPT = {
	title: "Saved filters",
	startUrl: "https://app.example/dashboard?dg_fixture=saved-filters",
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

test("--edit adds _edit=1 which the extension reads and strips", () => {
	const marked = addDemoMarker(SCRIPT.startUrl, SCRIPT, true);
	expect(readEditFlag(marked)).toBe(true);
	expect(readDemoScript(marked)).toEqual(SCRIPT); // script still decodes
	expect(stripDemoMarker(marked)).toBe(SCRIPT.startUrl); // both markers gone
});

test("no --edit → no edit flag", () => {
	expect(readEditFlag(addDemoMarker(SCRIPT.startUrl, SCRIPT))).toBe(false);
});

test("demo marker appended to an existing fragment is stripped back to it", () => {
	const marked = addDemoMarker(`${SCRIPT.startUrl}#section`, SCRIPT);
	expect(readDemoScript(marked)).toEqual(SCRIPT);
	expect(stripDemoMarker(marked)).toBe(`${SCRIPT.startUrl}#section`);
});

test("no demo marker → readDemoScript undefined, strip is a no-op", () => {
	const url = "https://app.example/dashboard?dg_fixture=1";
	expect(readDemoScript(url)).toBeUndefined();
	expect(stripDemoMarker(url)).toBe(url);
});

test("markers never touch the query string (no legit param collision)", () => {
	const marked = addDemoMarker(SCRIPT.startUrl, SCRIPT, true);
	expect(marked).toContain("?dg_fixture=saved-filters#_demo=");
	expect(new URL(marked).searchParams.get("dg_fixture")).toBe("saved-filters");
});

// --- plan.md round-trip (demo writes a plan → rerun extracts + validates it) ---

test("plan markdown round-trips via the native human-form reader (no json block)", () => {
	const md = toPlanMarkdown(validate(SCRIPT));
	expect(md).toContain("title: Saved filters");
	expect(md).not.toContain("```json");
	const parsed = validate(parsePlanMarkdown(md));
	expect(parsed.startUrl).toBe(SCRIPT.startUrl);
	expect(parsed.steps).toHaveLength(SCRIPT.steps.length);
	expect(parsed.steps[0]).toMatchObject({
		selector: "#save",
		title: "Save",
		body: SCRIPT.steps[0].body,
	});
});

test("legacy json-block plans still extract via extractScriptFromMarkdown", () => {
	const md = `\`\`\`json\n${JSON.stringify(SCRIPT)}\n\`\`\``;
	expect(validate(extractScriptFromMarkdown(md))).toEqual(SCRIPT);
});
