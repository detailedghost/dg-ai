---
covers: ["pkg/skills-cli/src/install/recommended-plugins.ts", "pkg/skills-cli/src/install/recommended-skills-only.ts", "scripts/bump-plugin-pin.ts", ".claude-plugin/marketplace.json", "docs/install.md"]
---

[ADR 0027](../../docs/adr/0027-optional-third-party-plugins.md)

- No dg skill may require an imported plugin. `imported-plugins-optional.spec.ts` enforces it.
- `.claude-plugin/marketplace.json` is the single list. Every entry except `dg` is a recommended plugin, pinned to a full commit sha. Keep no second list in code.
- `dg-skills install --with-recommended` installs them. The flag is off by default.
- For Claude Code, `install/recommended-plugins.ts` runs the `claude` plugin CLI and checks the installed sha.
- For `--skills-only --dest`, `install/recommended-skills-only.ts` fetches the pinned commit and copies the declared skills.
- Skip and name a skill that collides with a dg skill (`grill-me`, `wayfinder`).
- A failed fetch prints one warning and the install continues.
- Move a pin only with `scripts/bump-plugin-pin.ts`. `plugin-pins.spec.ts` guards every pin.
- Never float a pin on an upstream branch. Never vendor the upstream skills.
- `/dg:polish` skips `/unslop:unslop` when it is absent.
- dg retires its `teach` and `wait-what` copies. A skills install removes a retired folder only when its `SKILL.md` hash matches a dg copy.
