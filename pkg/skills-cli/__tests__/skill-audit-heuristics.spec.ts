import { expect, test } from "bun:test";
import { backReferencedHeadings, isPipelineShaped } from "../src/skill/audit";

test("isPipelineShaped: a numbered Process section is a pipeline signal", () => {
	const text = "## Process\n\n1. Do a thing\n2. Do another thing\n";
	expect(isPipelineShaped(text)).toBe(true);
});

test("isPipelineShaped: a Process heading without a numbered list is not a pipeline signal", () => {
	const text = "## Process\n\nSome prose with no numbered steps.\n";
	expect(isPipelineShaped(text)).toBe(false);
});

test("isPipelineShaped: an unrelated heading with a numbered list elsewhere is not a pipeline signal", () => {
	const text = "## Examples\n\n1. First example\n2. Second example\n";
	expect(isPipelineShaped(text)).toBe(false);
});

test("backReferencedHeadings: flags a heading whose keyword is cited via 'above'", () => {
	const text = [
		"## Dimensions (quality only)",
		"1. Reuse",
		"## Process",
		"1. Brief each with the eight Dimensions above.",
	].join("\n");
	expect(backReferencedHeadings(text)).toEqual(["Dimensions (quality only)"]);
});

test("backReferencedHeadings: flags a heading cited via 'below'", () => {
	const text = ["## Out of scope", "- redirect X", "## Process", "See Out of scope below for routing."].join("\n");
	expect(backReferencedHeadings(text)).toEqual(["Out of scope"]);
});

test("backReferencedHeadings: no flag when a heading is never cited elsewhere", () => {
	const text = ["## Usage", "how to call it", "## Notes", "caveats"].join("\n");
	expect(backReferencedHeadings(text)).toEqual([]);
});

test("backReferencedHeadings: no flag for short/generic headings that can't produce a distinctive keyword", () => {
	const text = ["## Do It", "content", "## Process", "do it above"].join("\n");
	expect(backReferencedHeadings(text)).toEqual([]);
});

