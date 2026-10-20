import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildReviewFileTree } from "../lib/review-file-tree";
import { highlightReviewSource, languageLabel } from "../lib/review-syntax";

/**
 * RED suite for three review-board enhancements layered on top of the
 * blank-diff-pane fix and the tree/scroll-spy work (see the sibling
 * *.test.ts files in this directory):
 *
 * 1. Marking a file "viewed" auto-collapses its diff card (GitHub-style);
 *    unchecking re-expands. The collapsed/expanded state is derived from
 *    `state.fileApprovals` (viewed flag) rather than tracked separately, so
 *    it naturally survives any re-render.
 * 2. A per-file "Add comment to file" affordance records a file-scoped
 *    comment, stored in the same `state.lineComments` collection as line
 *    comments (keyed `${path}::file`) so it flows through the existing
 *    `buildLineCommentsPayload()` into the submitted review_result,
 *    distinguishable from a line comment via `scope: 'file'` and
 *    `lineNumber: null`.
 * 3. File ordering (nav tree, "By file" diff-pane tree, and the flat
 *    commit/slice groupings) must be deterministic: directories before
 *    files, alphabetical case-insensitive by name at each tree level; full
 *    path alphabetical case-insensitive for the flat views.
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

/** Balanced-brace extraction that starts scanning for "{" on the signature's own line (handles object return-type annotations like `parsePatch`). */
function extractFunctionSource(scriptSrc: string, fnName: string): string {
  const defIdx = scriptSrc.search(new RegExp(`function\\s+${fnName}\\s*\\(`));
  if (defIdx === -1) throw new Error(`function ${fnName} not found in client script`);
  const firstNewline = scriptSrc.indexOf("\n", defIdx);
  const braceStart = scriptSrc.lastIndexOf("{", firstNewline === -1 ? scriptSrc.length : firstNewline);
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

function buildHarness(scriptSrc: string, fnNames: string[], stubState: Record<string, unknown>) {
  const combined = fnNames.map((f) => extractFunctionSource(scriptSrc, f)).join("\n\n");
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const jsSrc = transpiler.transformSync(combined);
  const factory = new Function(
    "state",
    "marked",
    "highlightReviewSource",
    "languageLabel",
    "sourceHighlighter",
    `const SLICE_LABEL_FALLBACK = 'Docs & other';\n${jsSrc}\nreturn { ${fnNames.join(", ")} };`,
  );
  return factory(stubState, { parse: (md: string) => `<p>${md}</p>` }, highlightReviewSource, languageLabel, null);
}

function makeFile(path: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    path,
    dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-old\n+new`,
    slice: null,
    commitSha: "abc1234",
    ...overrides,
  };
}

describe("ReviewSection.astro — 'Viewed' auto-collapses the file card", () => {
  it("fileCardHtml omits the `open` attribute when the file is marked viewed", () => {
    const scriptSrc = extractClientScript(readSource());
    const file = makeFile("a/b.py");
    const stubState = {
      fileApprovals: new Map([[file.path, { path: file.path, viewed: true }]]),
      lineComments: new Map(),
    };
    const { fileCardHtml } = buildHarness(
      scriptSrc,
      [
        "escapeHtml",
        "cssEscape",
        "renderMarkdown",
        "commentKey",
        "commentsFor",
        "fileCommentKey",
        "fileCommentsFor",
        "addCommentFormHtml",
        "fileCommentFormHtml",
        "commentRowHtml",
        "fileCommentThreadHtml",
        "parsePatch",
        "renderDiffTable",
        "fileKind",
        "sliceLabel",
        "fileCardHtml",
      ],
      stubState,
    ) as { fileCardHtml: (file: unknown) => string };

    const html = fileCardHtml(file);
    const detailsTagMatch = html.match(/<details\b[^>]*>/);
    expect(detailsTagMatch).not.toBeNull();
    expect(detailsTagMatch![0]).not.toMatch(/\bopen\b/);
  });

  it("fileCardHtml keeps the `open` attribute when the file is not viewed", () => {
    const scriptSrc = extractClientScript(readSource());
    const file = makeFile("a/b.py");
    const stubState = {
      fileApprovals: new Map([[file.path, { path: file.path, viewed: false }]]),
      lineComments: new Map(),
    };
    const { fileCardHtml } = buildHarness(
      scriptSrc,
      [
        "escapeHtml",
        "cssEscape",
        "renderMarkdown",
        "commentKey",
        "commentsFor",
        "fileCommentKey",
        "fileCommentsFor",
        "addCommentFormHtml",
        "fileCommentFormHtml",
        "commentRowHtml",
        "fileCommentThreadHtml",
        "parsePatch",
        "renderDiffTable",
        "fileKind",
        "sliceLabel",
        "fileCardHtml",
      ],
      stubState,
    ) as { fileCardHtml: (file: unknown) => string };

    const html = fileCardHtml(file);
    const detailsTagMatch = html.match(/<details\b[^>]*>/);
    expect(detailsTagMatch).not.toBeNull();
    expect(detailsTagMatch![0]).toMatch(/\bopen\b/);
  });

  it("the viewed-checkbox change handler collapses/expands the closest .rv-file-card details element to match", () => {
    const scriptSrc = extractClientScript(readSource());
    const bindBody = extractFunctionSource(scriptSrc, "bindDiffPaneEvents");
    // Must derive the card's open state from the checkbox rather than leaving
    // the DOM stale until the next full renderDiffPane() rebuild.
    expect(bindBody).toMatch(/closest\(['"]\.rv-file-card['"]\)/);
    expect(bindBody).toMatch(/\.open\s*=\s*!cb\.checked/);
  });
});

describe("ReviewSection.astro — file-scoped comments flow into the submitted review_result", () => {
  it("addFileComment records a comment with scope 'file' and lineNumber null under the `${path}::file` key", () => {
    const scriptSrc = extractClientScript(readSource());
    const stubState = { lineComments: new Map() };
    const { addFileComment, fileCommentsFor } = buildHarness(
      scriptSrc,
      ["fileCommentKey", "fileCommentsFor", "addFileComment"],
      stubState,
    ) as {
      addFileComment: (path: string, body: string) => void;
      fileCommentsFor: (path: string) => { scope: string; lineNumber: number | null; body: string }[];
    };

    addFileComment("lib/foo.py", "Consider splitting this file.");
    const comments = fileCommentsFor("lib/foo.py");
    expect(comments.length).toBe(1);
    expect(comments[0].scope).toBe("file");
    expect(comments[0].lineNumber).toBeNull();
    expect(comments[0].body).toBe("Consider splitting this file.");

    const lineCommentsMap = stubState.lineComments as Map<string, unknown[]>;
    expect(lineCommentsMap.has("lib/foo.py::file")).toBe(true);
  });

  it("a file comment and a line comment both flatten into buildLineCommentsPayload()'s array, distinguishable by scope", () => {
    const scriptSrc = extractClientScript(readSource());
    const stubState = { lineComments: new Map() };
    const { addFileComment, addComment, buildLineCommentsPayload } = buildHarness(
      scriptSrc,
      ["fileCommentKey", "addFileComment", "commentKey", "addComment", "buildLineCommentsPayload"],
      stubState,
    ) as {
      addFileComment: (path: string, body: string) => void;
      addComment: (path: string, side: "old" | "new", line: number, body: string) => void;
      buildLineCommentsPayload: () => {
        scope: string;
        lineNumber: number | null;
        body: string;
      }[];
    };

    addComment("lib/foo.py", "new", 12, "line-scoped note");
    addFileComment("lib/foo.py", "file-scoped note");

    const payload = buildLineCommentsPayload();
    expect(payload.length).toBe(2);
    const fileEntry = payload.find((c) => c.scope === "file");
    const lineEntry = payload.find((c) => c.scope === "line");
    expect(fileEntry?.body).toBe("file-scoped note");
    expect(fileEntry?.lineNumber).toBeNull();
    expect(lineEntry?.body).toBe("line-scoped note");
    expect(lineEntry?.lineNumber).toBe(12);
  });

  it("fileCardHtml renders an 'Add comment to file' affordance next to the viewed toggle", () => {
    const scriptSrc = extractClientScript(readSource());
    const file = makeFile("a/b.py");
    const stubState = {
      fileApprovals: new Map([[file.path, { path: file.path, viewed: false }]]),
      lineComments: new Map(),
    };
    const { fileCardHtml } = buildHarness(
      scriptSrc,
      [
        "escapeHtml",
        "cssEscape",
        "renderMarkdown",
        "commentKey",
        "commentsFor",
        "fileCommentKey",
        "fileCommentsFor",
        "addCommentFormHtml",
        "fileCommentFormHtml",
        "commentRowHtml",
        "fileCommentThreadHtml",
        "parsePatch",
        "renderDiffTable",
        "fileKind",
        "sliceLabel",
        "fileCardHtml",
      ],
      stubState,
    ) as { fileCardHtml: (file: unknown) => string };

    const html = fileCardHtml(file);
    expect(html).toContain("rv-file-comment-toggle-btn");
    expect(html).toMatch(/data-scope="file"/);
  });
});

describe("ReviewSection.astro — deterministic file ordering", () => {
  it("buildReviewFileTree sorts each folder's children: directories before files, alphabetical case-insensitive by name", () => {
    const files = [
      makeFile("z.py"),
      makeFile("Banana/x.py"),
      makeFile("apple/y.py"),
      makeFile("apple/Z.py"),
      makeFile("apple/a.py"),
      makeFile("a.py"),
    ];
    const root = buildReviewFileTree(files);
    // Root-level: folders "Banana"/"apple" (case-insensitively sorted) before files "a.py"/"z.py".
    const types = root.children.map((c) => c.type);
    const firstFileIdx = types.indexOf("file");
    expect(types.slice(0, firstFileIdx).every((t) => t === "folder")).toBe(true);
    const folderNames = root.children.filter((c) => c.type === "folder").map((c) => c.name);
    expect(folderNames).toEqual(
      [...folderNames].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
    );
    const fileNames = root.children.filter((c) => c.type === "file").map((c) => c.name);
    expect(fileNames).toEqual(["a.py", "z.py"]);

    const appleFolder = root.children.find((c) => c.type === "folder" && c.name.toLowerCase() === "apple") as {
      children: { type: string; name: string }[];
    };
    const appleFileNames = appleFolder.children.filter((c) => c.type === "file").map((c) => c.name);
    expect(appleFileNames).toEqual(["a.py", "y.py", "Z.py"]);
  });

  it("groupByCommit's and sliceRows' file lists are sorted by full path (case-insensitive)", () => {
    const scriptSrc = extractClientScript(readSource());
    const files = [
      makeFile("z.py", { commitSha: "c1", slice: "1" }),
      makeFile("A.py", { commitSha: "c1", slice: "1" }),
      makeFile("m.py", { commitSha: "c1", slice: "1" }),
    ];
    const commits = [{ sha: "c1", subject: "test commit" }];
    // Declared unsorted on purpose: sliceRows sorts what a slice declares, so an
    // implementation that passed declaration order straight through would fail here.
    const slices = [{ id: "1", label: "1", name: "test slice", files: ["z.py", "A.py", "m.py"] }];

    const combined = [
      extractFunctionSource(scriptSrc, "sortFilesByPath"),
      extractFunctionSource(scriptSrc, "groupByCommit"),
      extractFunctionSource(scriptSrc, "sliceRows"),
    ].join("\n\n");
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const jsSrc = transpiler.transformSync(combined);
    const factory = new Function(
      "FILES",
      "COMMITS",
      "SLICES",
      `const SLICE_LABEL_FALLBACK = 'Docs & other';\n${jsSrc}\nreturn { groupByCommit, sliceRows };`,
    );
    const { groupByCommit, sliceRows } = factory(files, commits, slices) as {
      groupByCommit: () => { files: { path: string }[] }[];
      sliceRows: () => { files: { path: string }[] }[];
    };

    expect(groupByCommit()[0].files.map((f) => f.path)).toEqual(["A.py", "m.py", "z.py"]);
    expect(sliceRows()[0].files.map((f) => f.path)).toEqual(["A.py", "m.py", "z.py"]);
  });
});
