import { describe, it, expect } from "bun:test";
import { validate, toPlanMarkdown, extractScriptFromMarkdown } from "../src/index";
import type { TourScript } from "../src/index";

const validScript: TourScript = {
	title: "My Tour",
	startUrl: "https://example.com",
	steps: [{ body: "Welcome to the tour." }],
	mode: "walkthrough",
};

describe("validate()", () => {
	it("accepts a valid TourScript", () => {
		expect(() => validate(validScript)).not.toThrow();
		const result = validate(validScript);
		expect(result.startUrl).toBe("https://example.com");
		expect(result.steps).toHaveLength(1);
	});

	it("throws on missing startUrl", () => {
		const bad = { steps: [{ body: "hi" }] };
		expect(() => validate(bad)).toThrow("startUrl");
	});

	it("throws on empty steps array", () => {
		const bad = { startUrl: "https://example.com", steps: [] };
		expect(() => validate(bad)).toThrow("non-empty");
	});

	it("throws on invalid mode", () => {
		const bad = { startUrl: "https://example.com", steps: [{ body: "hi" }], mode: "live" };
		expect(() => validate(bad)).toThrow("mode");
	});
});

describe("toPlanMarkdown()", () => {
	it("produces markdown containing the title and startUrl", () => {
		const md = toPlanMarkdown(validScript);
		expect(md).toContain("My Tour");
		expect(md).toContain("https://example.com");
	});

	it("includes a fenced json script block", () => {
		const md = toPlanMarkdown(validScript);
		expect(md).toContain("```json");
		expect(md).toContain("```");
	});
});

describe("extractScriptFromMarkdown()", () => {
	it("extracts the JSON block from a plan markdown string", () => {
		const md = toPlanMarkdown(validScript);
		const extracted = extractScriptFromMarkdown(md);
		expect(extracted).toMatchObject({ startUrl: "https://example.com" });
	});

	it("throws when no json block is present", () => {
		expect(() => extractScriptFromMarkdown("# No code block here")).toThrow(
			"no ```json script block found",
		);
	});
});
