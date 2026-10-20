import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RED suite for shift-click range commenting: click a gutter line, then
 * shift-click another line in the same file/side, to highlight the whole
 * block and leave one comment covering the range (GitHub's range-comment
 * UX). Layered on top of the existing single-line click-to-highlight
 * (`td.ln` click) and per-line comment form (`.rv-comment-form-row`,
 * keyed by the range's *end* line so no new DOM/render path is needed for
 * the common single-line case).
 */

const FILE_PATH = join(import.meta.dir, "ReviewSection.astro");

function readSource(): string {
	return readFileSync(FILE_PATH, "utf-8");
}

function extractClientScript(src: string): string {
	const frontmatterEnd = src.indexOf("\n---\n", src.indexOf("---") + 3);
	const searchSrc = frontmatterEnd === -1 ? src : src.slice(frontmatterEnd);
	const scriptTags = [...searchSrc.matchAll(/<script(\s[^>]*)?>/g)];
	for (const tag of scriptTags) {
		const attrs = tag[1] ?? "";
		if (attrs.includes("is:inline")) continue;
		const start = tag.index! + tag[0].length;
		const end = searchSrc.indexOf("</script>", start);
		if (end === -1) continue;
		return searchSrc.slice(start, end);
	}
	throw new Error("no client <script> block found in ReviewSection.astro");
}

function extractFunctionSource(scriptSrc: string, fnName: string): string {
	const defIdx = scriptSrc.search(new RegExp(`function\\s+${fnName}\\s*\\(`));
	if (defIdx === -1)
		throw new Error(`function ${fnName} not found in client script`);
	const firstNewline = scriptSrc.indexOf("\n", defIdx);
	const braceStart = scriptSrc.lastIndexOf(
		"{",
		firstNewline === -1 ? scriptSrc.length : firstNewline,
	);
	let depth = 0;
	for (let i = braceStart; i < scriptSrc.length; i++) {
		if (scriptSrc[i] === "{") depth++;
		else if (scriptSrc[i] === "}") {
			depth--;
			if (depth === 0) return scriptSrc.slice(defIdx, i + 1);
		}
	}
	throw new Error(`unbalanced braces extracting ${fnName}`);
}

describe("ReviewSection.astro — shift-click range selection (pure decision logic)", () => {
	it("computeLineRange orders the anchor and clicked line into [start, end] regardless of click direction", () => {
		const scriptSrc = extractClientScript(readSource());
		const fnSrc = extractFunctionSource(scriptSrc, "computeLineRange");
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const jsSrc = transpiler.transformSync(fnSrc);
		const computeLineRange = new Function(
			`${jsSrc}\nreturn computeLineRange;`,
		)() as (a: number, b: number) => [number, number];

		expect(computeLineRange(5, 10)).toEqual([5, 10]);
		expect(computeLineRange(10, 5)).toEqual([5, 10]);
		expect(computeLineRange(7, 7)).toEqual([7, 7]);
	});
});

describe("ReviewSection.astro — range comments are stored on the range's end line with a startLineNumber marker", () => {
	it("addComment accepts an optional startLineNumber distinct from the anchor lineNumber", () => {
		const scriptSrc = extractClientScript(readSource());
		const stubState = { lineComments: new Map() };
		const combined = [
			extractFunctionSource(scriptSrc, "commentKey"),
			extractFunctionSource(scriptSrc, "commentsFor"),
			extractFunctionSource(scriptSrc, "addComment"),
		].join("\n\n");
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const jsSrc = transpiler.transformSync(combined);
		const factory = new Function(
			"state",
			`${jsSrc}\nreturn { addComment, commentsFor };`,
		);
		const { addComment, commentsFor } = factory(stubState) as {
			addComment: (
				path: string,
				side: "old" | "new",
				line: number,
				body: string,
				startLine?: number,
			) => void;
			commentsFor: (
				path: string,
				side: "old" | "new",
				line: number,
			) => { startLineNumber?: number; lineNumber: number; body: string }[];
		};

		addComment("a.py", "new", 15, "spans a block", 12);
		const comments = commentsFor("a.py", "new", 15);
		expect(comments.length).toBe(1);
		expect(comments[0].lineNumber).toBe(15);
		expect(comments[0].startLineNumber).toBe(12);
		expect(comments[0].body).toBe("spans a block");

		// A plain single-line addComment call (no 5th arg) must keep working unchanged.
		addComment("a.py", "new", 20, "single line");
		const single = commentsFor("a.py", "new", 20);
		expect(single[0].startLineNumber).toBeUndefined();
	});

	it("commentRowHtml labels a range comment with its start and end lines", () => {
		const scriptSrc = extractClientScript(readSource());
		const stubState = { lineComments: new Map() };
		const combined = [
			extractFunctionSource(scriptSrc, "escapeHtml"),
			extractFunctionSource(scriptSrc, "renderMarkdown"),
			extractFunctionSource(scriptSrc, "commentKey"),
			extractFunctionSource(scriptSrc, "commentsFor"),
			extractFunctionSource(scriptSrc, "addComment"),
			extractFunctionSource(scriptSrc, "commentRowHtml"),
		].join("\n\n");
		const transpiler = new Bun.Transpiler({ loader: "ts" });
		const jsSrc = transpiler.transformSync(combined);
		const factory = new Function(
			"state",
			"marked",
			`${jsSrc}\nreturn { addComment, commentRowHtml };`,
		);
		const stubMarked = { parse: (md: string) => `<p>${md}</p>` };
		const { addComment, commentRowHtml } = factory(stubState, stubMarked) as {
			addComment: (
				path: string,
				side: "old" | "new",
				line: number,
				body: string,
				startLine?: number,
			) => void;
			commentRowHtml: (
				path: string,
				side: "old" | "new",
				line: number,
			) => string;
		};

		addComment("a.py", "new", 15, "spans a block", 12);
		const html = commentRowHtml("a.py", "new", 15);
		expect(html).toMatch(/12/);
		expect(html).toMatch(/15/);
	});
});

describe("ReviewSection.astro — shift-click wiring", () => {
	it("the td.ln click handler checks e.shiftKey and reuses a stored range anchor", () => {
		const scriptSrc = extractClientScript(readSource());
		expect(scriptSrc).toMatch(/rangeAnchor/);
		expect(scriptSrc).toMatch(/e\.shiftKey/);
		expect(scriptSrc).toMatch(/computeLineRange\(/);
	});

	it("opens the existing per-line comment form (keyed by the range's end line) rather than creating new DOM for every possible range", () => {
		const scriptSrc = extractClientScript(readSource());
		expect(scriptSrc).toMatch(/openRangeCommentForm/);
		const fnSrc = extractFunctionSource(scriptSrc, "openRangeCommentForm");
		expect(fnSrc).toMatch(/rv-comment-form-row/);
		expect(fnSrc).toMatch(/rangeStart/);
	});

	it("the add-comment handler reads a pending rangeStart off the form row and passes it through to addComment", () => {
		const scriptSrc = extractClientScript(readSource());
		const bindBody = extractFunctionSource(scriptSrc, "bindDiffPaneEvents");
		expect(bindBody).toMatch(/dataset\.rangeStart/);
	});
});
