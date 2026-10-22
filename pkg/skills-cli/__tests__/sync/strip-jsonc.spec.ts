import { describe, expect, test } from "bun:test";
import { stripJsonc } from "../../src/sync/strip-jsonc";

describe("stripJsonc", () => {
	test("strips leading // comment lines into header and returns valid JSON body", () => {
		const input = ["// This is a managed file.", JSON.stringify({ trustedFolders: [] })].join("\n");
		const { header, body } = stripJsonc(input);
		expect(header).toBe("// This is a managed file.");
		expect(() => JSON.parse(body)).not.toThrow();
		expect(JSON.parse(body)).toHaveProperty("trustedFolders");
	});

	test("preserves // sequences inside JSON string values", () => {
		const input = JSON.stringify({ url: "https://example.com//path", share: "//server/share" });
		const { body } = stripJsonc(input);
		const parsed = JSON.parse(body);
		expect(parsed.url).toBe("https://example.com//path");
		expect(parsed.share).toBe("//server/share");
	});

	test("strips trailing inline // comments on value lines", () => {
		const input = [`{ "key": "value" // inline comment`, `}`].join("\n");
		const { body } = stripJsonc(input);
		expect(() => JSON.parse(body)).not.toThrow();
		expect(JSON.parse(body).key).toBe("value");
	});

	test("returns an empty header when there are no leading comment lines", () => {
		const input = JSON.stringify({ a: 1 });
		const { header, body } = stripJsonc(input);
		expect(header).toBe("");
		expect(JSON.parse(body)).toEqual({ a: 1 });
	});

	test("multiple leading comment lines are all captured in header, in order", () => {
		const input = ["// line one", "// line two", JSON.stringify({ a: 1 })].join("\n");
		const { header } = stripJsonc(input);
		expect(header).toBe("// line one\n// line two");
	});
});
