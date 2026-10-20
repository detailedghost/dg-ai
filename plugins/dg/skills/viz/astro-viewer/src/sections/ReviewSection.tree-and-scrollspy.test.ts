import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RED suite for two review-board requirements layered on top of the blank-
 * diff-pane fix (see ReviewSection.marked-resilience.test.ts):
 *
 * 1. The "By file" diff-pane grouping must render as a real nested
 *    directory tree (folders containing folders containing file cards),
 *    matching the nav sidebar's existing tree — not a flat one-level list
 *    keyed by exact directory string (the current groupByFile() behavior).
 *
 * 2. Scroll-spy: as the user scrolls the diff pane, the file card most in
 *    view must become the nav's active/highlighted file. This is exercised
 *    at the level of the pure decision function (which path has the
 *    highest visibility ratio) since IntersectionObserver has no meaningful
 *    behavior to execute outside a real browser/DOM.
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
    `const SLICE_LABEL_FALLBACK = 'Docs & other';\n${jsSrc}\nreturn { ${fnNames.join(", ")} };`,
  );
  return factory(stubState, { parse: (md: string) => `<p>${md}</p>` });
}

describe("ReviewSection.astro — files are the primary shared-tree view", () => {
  it("opens with Files, Commit, Spec tabs and uses one tree builder for both panes", () => {
    const source = readSource();
    const filesTab = source.indexOf("data-mode='file'>Files</button>");
    const commitTab = source.indexOf("data-mode='commit'>Commit</button>");
    const specTab = source.indexOf("data-mode='slice'>Spec</button>");

    expect(source).toContain("class='rv-tab-btn active' data-mode='file'");
    expect(source).toContain("mode: 'file' as");
    expect(filesTab).toBeGreaterThan(-1);
    expect(commitTab).toBeGreaterThan(filesTab);
    expect(specTab).toBeGreaterThan(commitTab);
    expect(source.match(/buildReviewFileTree\(/g)).toHaveLength(2);
  });
});

describe("ReviewSection.astro — scroll-spy active-file tracking", () => {
  it("wires an IntersectionObserver over the diff pane's file cards and (re)initializes it after every renderDiffPane()", () => {
    const scriptSrc = extractClientScript(readSource());
    expect(scriptSrc).toMatch(/new IntersectionObserver/);
    expect(scriptSrc).toMatch(/\.rv-file-card/);

    // initScrollSpy (or equivalent) must run after renderDiffPane() rebuilds the
    // pane's DOM — otherwise the observer keeps stale/disconnected element refs
    // once the user switches grouping mode or adds/removes a comment.
    const renderDiffPaneBody = extractFunctionSource(scriptSrc, "renderDiffPane");
    expect(renderDiffPaneBody).toMatch(/initScrollSpy\(\)/);
  });

  it("pickMostVisiblePath picks the path with the highest visibility ratio", () => {
    const scriptSrc = extractClientScript(readSource());
    const { pickMostVisiblePath } = buildHarness(scriptSrc, ["pickMostVisiblePath"], {}) as {
      pickMostVisiblePath: (ratios: Map<string, number>) => string | null;
    };

    const ratios = new Map([
      ["a/b.py", 0.2],
      ["c/d.py", 0.9],
      ["e/f.py", 0.5],
    ]);
    expect(pickMostVisiblePath(ratios)).toBe("c/d.py");
  });

  it("pickMostVisiblePath returns null when nothing is visible", () => {
    const scriptSrc = extractClientScript(readSource());
    const { pickMostVisiblePath } = buildHarness(scriptSrc, ["pickMostVisiblePath"], {}) as {
      pickMostVisiblePath: (ratios: Map<string, number>) => string | null;
    };

    const ratios = new Map([
      ["a/b.py", 0],
      ["c/d.py", 0],
    ]);
    expect(pickMostVisiblePath(ratios)).toBeNull();
  });

  it("updates state.activeFile and re-highlights the nav when the most-visible path changes", () => {
    const scriptSrc = extractClientScript(readSource());
    const stubState = {
      activeFile: null as string | null,
      fileApprovals: new Map(),
      collapsedDirs: new Set(),
    };
    let navHighlightCalls = 0;

    const combined = [
      extractFunctionSource(scriptSrc, "pickMostVisiblePath"),
      extractFunctionSource(scriptSrc, "applyScrollSpyResult"),
    ].join("\n\n");
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const jsSrc = transpiler.transformSync(combined);
    const factory = new Function(
      "state",
      "renderNavActiveOnly",
      "scrollActiveNavIntoView",
      `${jsSrc}\nreturn { applyScrollSpyResult };`,
    );
    const { applyScrollSpyResult } = factory(
      stubState,
      () => {
        navHighlightCalls++;
      },
      () => {},
    ) as { applyScrollSpyResult: (ratios: Map<string, number>) => void };

    applyScrollSpyResult(new Map([["x/y.py", 0.8]]));

    expect(stubState.activeFile).toBe("x/y.py");
    expect(navHighlightCalls).toBe(1);
  });
});
