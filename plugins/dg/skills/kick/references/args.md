# Arguments

| Form | Effect |
|---|---|
| `/kick` | No arg — `<request>` is left empty; `/spec`'s own dispatch rule asks the one clarifying question before its grill-me pass 1 derives the feature name and slug from the interview, as usual. |
| `/kick <name>` | `<name>` is folded into the request text handed to `/spec` (e.g. `/spec "Feature: <name>. <name>"`) as a working-title seed. `/spec` plan-mode step 1 still derives the authoritative `<slug>` via `~/.dg/bin/dg-skills spec slugify` from the grill-me pass — `<name>` is a naming hint, not a guarantee of the final slug. |
| `/kick <name> --from <path>` | Read the file at `<path>` (for example a design summary) as the request text handed to `/spec`. `<name>` stays the working-title seed. The interview still runs, seeded with the file. |

The usage line in `SKILL.md` carries these forms; keep it in sync with this table.

**Findability note:** `~/.dg/bin/dg-skills spec scaffold`'s NNN auto-increment means two kicked bundles can share a
slug under different `<NNN>` prefixes — that's not a collision (each bundle dir is unique), just
something to be aware of when substring-matching in `/pickup`.

**Not supported:**

- `--viz` — `/spec` plan mode already renders its one board at step 8 unconditionally.
- `-l`/`--light` — every `/spec` bundle lives under `.agents/spec/`, `--fast` included, so there is
  no throwaway bundle path to park. `/kick` is a *defer* verb and `/spec --fast` a *build-now* one,
  so `--fast` is not forwardable either — a kicked bundle is picked up later via `/pickup`.
