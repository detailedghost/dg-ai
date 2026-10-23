# Drawing rules for /dg:eli5

One picture per answer. The picture carries the idea, so draw the idea — not the file list.

## Recipe

1. Name the **actors** first: who does something, who holds something. 6 boxes or fewer.
2. Give every box two lines: the real name, then a plain-word gloss in parens.
3. Draw the **flow**, not the structure: what moves, in what order.
4. Label every arrow with a verb (`asks`, `saves`, `sends back`, `checks`). Number the arrows
   when order matters.
5. Left to right for a flow. Top to bottom for a "made of" or "owns" picture.
6. Nothing unconnected. A box with no arrow does not belong in the picture.
7. Characters: `┌ ┐ └ ┘ │ ─ ► ◄ ▼ ▲ ┬ ┴ ├ ┤`. No ASCII-art fonts, no shading, no color codes.

## Worked example — a web request

```
┌───────────┐   1. asks for    ┌───────────┐  2. looks in  ┌───────────┐
│    YOU    │ ───────────────► │    APP    │ ────────────► │  BIG BOX  │
│ (browser) │                  │ (server)  │               │(database) │
└───────────┘ ◄─────────────── └───────────┘ ◄──────────── └───────────┘
                4. shows you                 3. hands back
```

## Worked example — a codebase, collapsed

Nine files, three boxes. Each box is a job, not a folder path.

```
┌──────────────┐   asks    ┌──────────────┐
│   index.ts   │ ────────► │   engines/   │
│ (front door) │           │  (talkers)   │
└──────┬───────┘           └──────┬───────┘
       │                          │
       │ uses                     │ uses
       │        ┌──────────────┐  │
       └───────►│     lib/     │◄─┘
                │  (toolbox)   │
                └──────────────┘
```

## `--erd [target]` — collapse a real graph

1. Get the graph. Fuzzy input goes through `/dg:erd` proper, so the candidate picker still runs:

   ```bash
   ~/.dg/bin/dg-skills erd generate <scope>
   ```

2. Read three things from the generated `.md`: the **Scope** summary line, the **Modules** table,
   and the **Import Graph**. Skip the evidence appendix.
3. Group modules into 6 boxes or fewer, usually one per top-level directory. Name each box for
   its **job** — the highest-degree module in the group tells you what that job is.
4. Keep only the arrows that cross box boundaries. Drop the inside-a-box arrows.
5. Two boxes with no edge between them stay unconnected. Say "these two do not talk" rather
   than drawing a line that is not in the graph.
6. Tables, if the graph has any, get a **second** small picture. Write the relation in words —
   "one shop has many orders" — never crow's feet.
7. Close with the `.md` path, one line, so the user can go deeper:
   `Full map: .agents/architecture/<slug>.md`

Never invent an edge, a module or a table. The graph is the source; the drawing only shrinks it.
