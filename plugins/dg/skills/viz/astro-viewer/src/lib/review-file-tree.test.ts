import { describe, expect, it } from "bun:test";
import { buildReviewFileTree, type ReviewFileTreeNode } from "./review-file-tree";

interface TestFile {
  path: string;
}

function traversedPaths(nodes: ReviewFileTreeNode<TestFile>[]): string[] {
  return nodes.flatMap((node) => (node.type === "file" ? [node.file.path] : traversedPaths(node.children)));
}

describe("buildReviewFileTree", () => {
  it("uses compact folders and one deterministic folder-first ordering", () => {
    const files = [
      { path: "zeta.ts" },
      { path: "packages/api/Zulu.cs" },
      { path: "packages/api/alpha.cs" },
      { path: "docs/readme.md" },
      { path: "alpha.ts" },
    ];

    const tree = buildReviewFileTree(files);

    expect(tree.children.map((node) => node.name)).toEqual(["docs", "packages/api", "alpha.ts", "zeta.ts"]);
    expect(traversedPaths(tree.children)).toEqual([
      "docs/readme.md",
      "packages/api/alpha.cs",
      "packages/api/Zulu.cs",
      "alpha.ts",
      "zeta.ts",
    ]);
  });
});
