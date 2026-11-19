# Ask Mode

Explain a feature from the ADRs at a chosen level. Ask mode writes no file.

## Steps

1. Test for `.agents/decisions/README.md`. If it is missing, stop with one line: `No ADRs here. Run dg-skills adr init first.`
2. Pick the level. Use `--level` when given. Else use the `level:` key in the README frontmatter. Else use `high-school`. Ignore per-ADR `Level:` lines.
3. Run `dg-skills adr find <words from the question>`. When the question names files, also run `dg-skills adr relevant <paths>`.
4. Read each matched ADR and decision. No match? Say that no ADR covers the question. Invent nothing.
5. Answer at the level. Cite the ADR numbers, such as `ADR 0007`. Add a Mermaid diagram only when it helps.
6. Check the answer: pipe it to `dg-skills adr lint --grade - --level <l>`. Exit 1 means the grade is too high. Rewrite shorter and check again. Reply only after exit 0.

## Grade limits

| Level | Grade limit |
|---|---|
| `eli5` | 4 |
| `high-school` | 10 |
| `college` | 14 |
| `phd`, `technical` | none |

See [levels.md](levels.md).
