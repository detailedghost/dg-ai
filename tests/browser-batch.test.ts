import { expect, test } from "bun:test";
import { readGroupMarker, stripGroupMarker } from "../extension-src/lib/marker";
import { versionGte } from "../skills/browser-batch/bin/lib";
import { addGroupMarker } from "../skills/browser-batch/bin/marker";
import { resolveRef } from "../skills/browser-batch/bin/refs";

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
