---
covers: ["pkg/skills-cli/src/layout/**", "pkg/skills-cli/src/prototype/accepted.ts", "pkg/skills-cli/src/verify/**", "plugins/dg/skills/verify/**"]
---

[ADR 0033](../../docs/adr/0033-accepted-prototype-layout-gate.md)

- Make `sentinels.wait()` call `recordAcceptance()` on an approve claim. Write `.agents/prototype/<name>/accepted.json` and six reference PNGs. Do not change stdout.
- Make `dg-skills verify` fail on any layout difference the reviewer did not accept on the board.
- Mark the feature, every variant and the built feature with `data-verify-root="<prototype name>"`. Require exactly one visible root.
- Read each control under the root in DOM order at 1440, 768 and 390 wide, in light and dark. Record role, name, test id, box, bands, visibility and an `elementFromPoint` occlusion check.
- Match controls by test id, else by role and normalized name. Compare positions as fractions of the root. Count a band change as `moved` only when the center shifts by 0.1 of the root or more.
- Return diff rows of kind `root-missing`, `missing`, `extra`, `reordered`, `moved`, `visibility`, `occluded`, `theme` or `not-checked`, each with an id that stays stable between rounds.
- Show a Layout pill and a table with an Accept box per row. `Verdict.layout` holds accepted ids. `mergeVerdicts` refuses an unknown id and a plain approve while a row is unaccepted.
- Print `| layout: N unaccepted` in `verify status`. Hold `ALL APPROVED` until N is 0.
- Give one `not-checked` row per role for the http engine, `--ext` records and `--no-fingerprint` records.
- Never fail on pixel differences. Use the reference PNGs as the prototype column when no prototype server runs.
- Run `spec prototype-ref` to copy the text-only record into the spec bundle. Keep the sandbox record gitignored.
