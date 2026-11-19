# Reading Levels

A level sets how simply the prose reads. `dg-skills adr lint` grades each ADR against the limit. The level comes from the ADR `Level:` line, else the `level:` key in `.agents/decisions/README.md`, else `high-school`.

| Level | Grade limit | In plain words |
|---|---|---|
| `eli5` | 4 | Short words and one idea per sentence. A child could follow it. |
| `high-school` | 10 | Plain English. Explain each term once. The default. |
| `college` | 14 | Normal technical writing. Terms of art need no gloss. |
| `phd` | none | Full technical depth. No grade limit. |
| `technical` | none | The same level as `phd`. Use either name; the CLI stores it as typed. |

`ask` mode ignores per-ADR `Level:` lines. It answers at the level the user asks for.
