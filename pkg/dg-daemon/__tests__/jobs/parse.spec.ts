import { describe, expect, it } from "bun:test";
import { parseFeedLines } from "../../src/jobs/parse";

function ok(stdout: string) {
	const result = parseFeedLines(stdout);
	if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
	return result.items;
}

function err(stdout: string): string {
	const result = parseFeedLines(stdout);
	if (result.ok) throw new Error("expected a parse error, got items");
	return result.error;
}

describe("parseFeedLines", () => {
	it("reads one item per line, keyed by id", () => {
		const items = ok(
			'{"id":"JRDEV-812","title":"Quote export times out"}\n' +
				'{"id":"JRDEV-807","title":"Sprint carry-over needs an owner"}\n',
		);
		expect(items).toEqual([
			{ fingerprint: "JRDEV-812", title: "Quote export times out" },
			{ fingerprint: "JRDEV-807", title: "Sprint carry-over needs an owner" },
		]);
	});

	it("carries the optional meta and url through", () => {
		const [item] = ok(
			'{"id":"a","title":"A","meta":"assigned to you","url":"https://example.invalid/a"}',
		);
		expect(item.meta).toBe("assigned to you");
		expect(item.url).toBe("https://example.invalid/a");
	});

	it("accepts no output at all as no items", () => {
		expect(ok("")).toEqual([]);
		expect(ok("\n  \n\n")).toEqual([]);
	});

	it("tolerates CRLF line endings", () => {
		expect(
			ok('{"id":"a","title":"A"}\r\n{"id":"b","title":"B"}\r\n'),
		).toHaveLength(2);
	});

	it("keeps the first of two lines sharing an id", () => {
		const items = ok('{"id":"a","title":"first"}\n{"id":"a","title":"second"}');
		expect(items).toEqual([{ fingerprint: "a", title: "first" }]);
	});

	it("names the line number when a line is not JSON", () => {
		const message = err('{"id":"a","title":"A"}\nnot json at all');
		expect(message).toContain("line 2");
	});

	it("rejects a line that is JSON but not an object", () => {
		expect(err('["id","title"]')).toContain("line 1");
		expect(err('"a string"')).toContain("line 1");
	});

	it("rejects a line missing id or title, naming the field", () => {
		expect(err('{"title":"no id"}')).toContain("id");
		expect(err('{"id":"a"}')).toContain("title");
	});

	it("rejects an id or title that is empty or not a string", () => {
		expect(err('{"id":"","title":"A"}')).toContain("id");
		expect(err('{"id":7,"title":"A"}')).toContain("id");
		expect(err('{"id":"a","title":""}')).toContain("title");
	});

	it("rejects a non-string meta or url rather than coercing it", () => {
		expect(err('{"id":"a","title":"A","meta":7}')).toContain("meta");
		expect(err('{"id":"a","title":"A","url":{"href":"x"}}')).toContain("url");
	});

	it("treats an explicit null meta or url as absent", () => {
		const [item] = ok('{"id":"a","title":"A","meta":null,"url":null}');
		expect(item.meta).toBeUndefined();
		expect(item.url).toBeUndefined();
	});
});
