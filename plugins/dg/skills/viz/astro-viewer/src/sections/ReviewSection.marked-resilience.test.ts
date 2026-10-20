import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { highlightReviewSource } from "../lib/review-syntax";

/**
 * RED suite reproducing the "diff pane renders empty" bug.
 *
 * Root cause (confirmed via a real headless-browser load against the dev
 * server, see task evidence): the client <script> in ReviewSection.astro
 * opens with a static `import { marked } from 'marked'`. When Vite's
 * optimize-deps cache for that dependency goes stale (observed in the wild
 * as a "504 Outdated Optimize Dep" on /node_modules/.vite/deps/marked.js),
 * the browser fails to resolve that static import. A failed static ES
 * module import aborts evaluation of the ENTIRE module before a single
 * line of it runs — so renderMetaStrip(), renderNav(), and renderDiffPane()
 * at the bottom of the script never execute, and every dynamically-built
 * region of the board (nav tree, meta strip, diff pane) stays exactly as
 * empty as Astro's SSR left it.
 *
 * The fix is to stop letting the whole board's fate ride on one dependency
 * loading successfully: load `marked` dynamically inside a try/catch so a
 * failure there is caught and degrades only markdown rendering, instead of
 * being an unrecoverable module-load failure that wipes the whole board.
 */

const FILE_PATH = join(import.meta.dir, "ReviewSection.astro");

function readSource(): string {
  return readFileSync(FILE_PATH, "utf-8");
}

/**
 * Extracts the balanced-brace body of the first non-inline <script> block
 * (the client script). Search starts after the frontmatter's closing `---`
 * fence — the frontmatter's leading docblock comment literally contains the
 * text "<script>" in prose, which a naive whole-file regex would mistake
 * for a real tag.
 */
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

/**
 * Balanced-brace extraction of a named function's full source. Unlike the
 * sibling CytoscapeSection.test.ts helper, this scans for the body's opening
 * brace on the function's own signature line rather than the first "{" after
 * the name — several functions here (e.g. parsePatch) have an object return
 * type annotation (`: { rows: DiffRow[]; ... }`) whose own braces would
 * otherwise be mistaken for the function body.
 */
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

/** Transpiles real extracted TS source to JS and evaluates it, returning the callable function. */
function loadRealFunction(
  scriptSrc: string,
  fnName: string,
  injectedGlobals: Record<string, unknown> = {},
): (...args: unknown[]) => unknown {
  const tsSrc = extractFunctionSource(scriptSrc, fnName);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const jsSrc = transpiler.transformSync(tsSrc);
  const argNames = Object.keys(injectedGlobals);
  const factory = new Function(...argNames, `${jsSrc}\nreturn ${fnName};`);
  return factory(...argNames.map((k) => injectedGlobals[k]));
}

describe("ReviewSection.astro — marked import resilience (root cause of blank diff pane)", () => {
  it("does not statically import { marked } from 'marked' at module scope (a failed static import aborts the whole client script — nav, meta strip, and diff pane never render)", () => {
    const scriptSrc = extractClientScript(readSource());
    expect(scriptSrc).not.toMatch(/^\s*import\s*\{\s*marked\s*\}\s*from\s*['"]marked['"]/m);
  });

  it("loads marked defensively (dynamic import inside a try/catch), not as an unguarded static import", () => {
    const scriptSrc = extractClientScript(readSource());
    expect(scriptSrc).toMatch(/await\s+import\(['"]marked['"]\)/);
    // The dynamic import must actually be reachable from inside a try block —
    // otherwise a rejected import() still propagates as an unhandled error.
    const importIdx = scriptSrc.search(/await\s+import\(['"]marked['"]\)/);
    const before = scriptSrc.slice(0, importIdx);
    // "try {" shortly before the import call confirms it's try/catch-guarded.
    expect(before.slice(-80)).toMatch(/try\s*\{/);
  });

  it("renderMarkdown degrades to escaped plain text instead of throwing when marked failed to load", () => {
    const scriptSrc = extractClientScript(readSource());
    const escapeHtml = loadRealFunction(scriptSrc, "escapeHtml") as (s: string) => string;
    const renderMarkdown = loadRealFunction(scriptSrc, "renderMarkdown", {
      marked: null,
      escapeHtml,
    }) as (md: string) => string;

    // Must not throw when the module-level `marked` failed to load.
    let result = "";
    expect(() => {
      result = renderMarkdown("# hello *world*");
    }).not.toThrow();
    // And it must actually show the raw content (escaped), not silently drop it.
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });
});

describe("ReviewSection.astro — diff rendering still works when the current bug is present (sanity, not the regression itself)", () => {
  it("parsePatch + renderDiffTable produce diff rows containing real patch content (proves the renderer itself is fine; the bug is upstream module-load resilience)", () => {
    const scriptSrc = extractClientScript(readSource());
    const fns = [
      "parsePatch",
      "escapeHtml",
      "cssEscape",
      "commentKey",
      "commentsFor",
      "addCommentFormHtml",
      "commentRowHtml",
      "renderDiffTable",
    ];
    const combined = fns.map((f) => extractFunctionSource(scriptSrc, f)).join("\n\n");
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const jsSrc = transpiler.transformSync(combined);
    const factory = new Function(
      "state",
      "highlightReviewSource",
      "sourceHighlighter",
      `${jsSrc}\nreturn { renderDiffTable };`,
    );
    const { renderDiffTable } = factory({ lineComments: new Map() }, highlightReviewSource, null);

    const patch = [
      "diff --git a/foo.py b/foo.py",
      "index 0000000..1111111 100644",
      "--- a/foo.py",
      "+++ b/foo.py",
      "@@ -1,1 +1,2 @@",
      "-old line",
      "+def _paginate(): pass",
    ].join("\n");

    const html = renderDiffTable({ path: "foo.py", patch }) as string;
    expect(html).toContain("_paginate");
  });
});
