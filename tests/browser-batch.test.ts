import { expect, test } from "bun:test";
import { globToRegExp, urlMatches } from "../extension-src/lib/glob";
import { versionGte } from "../skills/browser-batch/bin/lib";
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

test("bare number resolves with defaultRepo argument", () => {
	expect(resolveRef("1518", {}, "owner/repo")).toBe(
		"https://github.com/owner/repo/pull/1518",
	);
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
	expect(versionGte("2.0.0", "10.0.0")).toBe(false);
});

// --- glob matcher (extension grouping) ---

test("glob matches GitHub PR URLs, not arbitrary pages", () => {
	const patterns = ["*://github.com/*/*/pull/*"];
	expect(urlMatches("https://github.com/o/r/pull/5", patterns)).toBe(true);
	expect(urlMatches("https://github.com/o/r/issues/5", patterns)).toBe(false);
	expect(urlMatches("https://example.com/x", patterns)).toBe(false);
});

test("globToRegExp anchors and escapes literals", () => {
	expect(globToRegExp("a.b*").test("a.bXYZ")).toBe(true);
	expect(globToRegExp("a.b*").test("aXbXYZ")).toBe(false); // '.' is literal, not wildcard
});
