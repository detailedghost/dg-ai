import { expect, test } from "bun:test";
import { escapeRegExp } from "../src/regex";

test("escapes every regex metacharacter", () => {
	const text = ".*+?^${}()|[]\\";
	expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true);
});

test("leaves plain names unchanged", () => {
	expect(escapeRegExp("plain-name")).toBe("plain-name");
});
