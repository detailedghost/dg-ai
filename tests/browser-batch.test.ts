import { expect, test } from "bun:test";
import { resolveRef } from "../skills/browser-batch/bin/browser-batch.ts";

test("full URL passes through unchanged", () => {
	const url = "https://github.com/owner/repo/pull/123";
	expect(resolveRef(url, {}, undefined)).toBe(url);
});

test("owner/repo#num resolves to GitHub pull URL", () => {
	expect(resolveRef("owner/repo#123", {}, undefined)).toBe("https://github.com/owner/repo/pull/123");
});

test("config alias resolves to its pull URL", () => {
	expect(resolveRef("work#1517", { aliases: { work: "your-org/your-repo" } }, undefined)).toBe(
		"https://github.com/your-org/your-repo/pull/1517",
	);
});

test("bare number resolves with defaultRepo argument", () => {
	expect(resolveRef("1518", {}, "owner/repo")).toBe("https://github.com/owner/repo/pull/1518");
});

test("bare number resolves via cfg.defaultRepo when no --repo arg", () => {
	expect(resolveRef("1518", { defaultRepo: "owner/repo" }, undefined)).toBe("https://github.com/owner/repo/pull/1518");
});

test("bare number without default repo throws", () => {
	expect(() => resolveRef("1518", {}, undefined)).toThrow();
});
