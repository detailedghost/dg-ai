import { describe, expect, it } from "bun:test";
import {
  highlightReviewSource,
  languageForPath,
  languageLabel,
  type ReviewSyntaxHighlighter,
} from "./review-syntax";

const highlighter: ReviewSyntaxHighlighter = {
  highlight(code) {
    const value = code
      .replace(/\bconst\b/g, '<span class="hljs-keyword">const</span>')
      .replace(/\b\d+\b/g, '<span class="hljs-number">$&</span>');
    return { value };
  },
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

describe("review syntax", () => {
  it.each([
    ["packages/api/ExportRoutes.cs", "csharp", "C#"],
    ["packages/extension/useZipExport.spec.ts", "typescript", "TypeScript"],
    ["terraform/cleanup.tf", "plaintext", "Terraform"],
    [".github/workflows/ci.yml", "yaml", "YAML"],
    ["Dockerfile", "dockerfile", "Dockerfile"],
  ])("maps %s to its review grammar", (path, language, label) => {
    expect(languageForPath(path)).toBe(language);
    expect(languageLabel(path)).toBe(label);
  });

  it("returns language token markup from the registered grammar", () => {
    const html = highlightReviewSource("const answer: number = 42;", "answer.ts", highlighter, escapeHtml);

    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('class="hljs-number"');
  });

  it("safely escapes unknown files and highlighter failures", () => {
    expect(highlightReviewSource("<unsafe>", "asset.bin", highlighter, escapeHtml)).toBe("&lt;unsafe>");
    expect(
      highlightReviewSource(
        "<unsafe>",
        "source.cs",
        {
          highlight() {
            throw new Error("grammar failed");
          },
        },
        escapeHtml,
      ),
    ).toBe("&lt;unsafe>");
  });
});
