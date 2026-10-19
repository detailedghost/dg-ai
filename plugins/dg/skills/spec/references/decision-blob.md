# Decision Blob — input to `"$DG" spec scaffold --from-json`

Plan-mode step 3: after the two grill-me passes (steps 1–2) converge, the **foreman** agent
emits this compact JSON. It replaces the old hand-written spec
template — instead of hand-writing `plan.md` prose, foreman emits structured data and
`"$DG" spec scaffold` expands it deterministically into the bundle (`plan.md` frontmatter + body
skeleton, `initial.md`, one `roundtable/slice-<N>.md` shell per slice).

**LOCK the shape** (keys, nesting, types) — do not redesign or rename fields; `scaffold` parses
this exact structure.

```json
{
  "feature": "<human-readable feature name>",
  "slug": "<feature_snake_case>",
  "purpose": "<2-4 sentence purpose statement>",
  "scope": {
    "included": ["<in-scope bullet>", "..."],
    "excluded": ["<out-of-scope bullet>", "..."]
  },
  "slices": [
    {
      "id": 1,
      "name": "<kebab-slice-name>",
      "depends_on": [],
      "files": ["<glob the slice owns>"],
      "engineering": ["<implementation checklist item>", "..."],
      "testing": ["<testing-criteria item; first items are the Contracts>", "..."],
      "acceptance": ["<Given/When/Then or testable statement>", "..."],
      "proxy": null,
      "proxy_skills": []
    }
  ]
}
```

## Field rules

- `feature`, `slug`, `purpose`, `scope`, `slices` are REQUIRED. `scope.included`/`scope.excluded`
  are arrays (may be empty). `slices` must be non-empty.
- Per slice: `id` (1-based integer), `name`, `depends_on` (array of ids, may be empty), `files`
  (globs), `engineering`, `testing`, `acceptance` (arrays, may be empty).
- `proxy`: one of `"codex" | "copilot" | "pi" | "opencode" | null`. `null` (or omitted) = internal
  agent; scaffold omits `agents.proxy` in frontmatter.
- `proxy_skills`: array of skill names (e.g. `["db", "polish"]`); scaffold omits
  `agents.proxy_skills` in frontmatter when empty/absent. These are the skill-behaviors a proxied
  slice needs — `/spec -s` inlines them into the `/proxy` prompt because `/proxy` injects only the
  persona file and can't run `/db` or `/polish` as slash-commands.
- `serializing` (optional, top level): code-generator outputs. Each entry is
  `{"writes": ["<output glob>"], "when": ["<glob that triggers the generator>"]}`. A slice whose
  `files` overlap a `when` glob owns the `writes` globs for `lint-waves`. A bare string entry means
  the glob itself. Scaffold ignores it.
- Unknown top-level keys are ignored by scaffold (forward-compatible); the five REQUIRED keys are
  hard-checked.

## Producing the blob

Write it to scratch — `$("$DG" stash -s spec <slug>-blob.json)` — then run:

```sh
"$DG" spec lint-waves <blob-path>
"$DG" spec scaffold --home .agents/spec --slug <slug> --from-json <blob-path>
```

`lint-waves` exits non-zero when two slices in one `/sdlc` layer can touch the same path; scaffold
runs it too and refuses (`--allow-overlap` overrides).

On success it prints the created bundle's absolute path (`.agents/spec/<NNN>_<slug>/`). Do NOT
hand-write `plan.md`/`initial.md`/`roundtable/*.md` directly at this step — that's the whole point
of routing through the blob: deterministic expansion, not free-form prose.

`agents.primary`/`effort`/`qa` are deliberately absent from the blob — `/assign` (run immediately
after scaffold, step 3) picks those against the live agent roster. Only `proxy`/`proxy_skills` are
plan-mode's call, since they're a delegation decision the foreman/user make during planning,
not a capability match `/assign` can infer.
