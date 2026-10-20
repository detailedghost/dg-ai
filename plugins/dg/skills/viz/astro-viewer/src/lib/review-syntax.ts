export interface ReviewSyntaxHighlighter {
  highlight(code: string, options: { language: string; ignoreIllegals: boolean }): { value: string };
}

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  gemfile: "ruby",
  makefile: "makefile",
  rakefile: "ruby",
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  astro: "xml",
  bash: "bash",
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  cshtml: "xml",
  csproj: "xml",
  css: "css",
  fs: "fsharp",
  fsx: "fsharp",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "c",
  hcl: "plaintext",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  php: "php",
  props: "xml",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svg: "xml",
  swift: "swift",
  targets: "xml",
  tf: "plaintext",
  tfvars: "plaintext",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  css: "CSS",
  dockerfile: "Dockerfile",
  fsharp: "F#",
  go: "Go",
  graphql: "GraphQL",
  ini: "INI/TOML",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  makefile: "Makefile",
  markdown: "Markdown",
  php: "PHP",
  plaintext: "Text",
  powershell: "PowerShell",
  python: "Python",
  ruby: "Ruby",
  rust: "Rust",
  scss: "SCSS",
  sql: "SQL",
  swift: "Swift",
  typescript: "TypeScript",
  xml: "HTML/XML",
  yaml: "YAML",
};

export function languageForPath(path: string): string | null {
  const filename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const namedLanguage = LANGUAGE_BY_FILENAME[filename];
  if (namedLanguage) return namedLanguage;
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".") + 1) : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

export function languageLabel(path: string): string | null {
  if (/\.tf(?:vars)?$/i.test(path)) return "Terraform";
  if (/\.hcl$/i.test(path)) return "HCL";
  const language = languageForPath(path);
  return language ? (LANGUAGE_LABELS[language] ?? language) : null;
}

export function highlightReviewSource(
  code: string,
  path: string,
  highlighter: ReviewSyntaxHighlighter | null,
  escapeHtml: (value: string) => string,
): string {
  const language = languageForPath(path);
  if (!language || language === "plaintext" || !highlighter) return escapeHtml(code);
  try {
    return highlighter.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}
