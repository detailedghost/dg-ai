# `erd render` data shapes

Every input is one JSON object. Use `--data file.json` or `--data -` for stdin.

## `er`

```json
{"nodes":[{"id":"public.users","label":"users","schema":"public","source":"static-sql","columns":[{"name":"id","dataType":"uuid","nullable":false,"isPrimaryKey":true}]}],"edges":[]}
```

Nodes use the `DbNode` shape. Edges use `{ "from", "to", "fromColumn", "toColumn", "confidence": "proven" | "inferred" }`.

## `flow`

```json
{"nodes":[{"id":"src/index.ts","label":"index.ts","kind":"file"},{"id":"src/store.ts","label":"store.ts","kind":"file"}],"edges":[{"from":"src/index.ts","to":"src/store.ts","kind":"import","evidence":"line 1"}]}
```

Nodes use the `CodeNode` shape. Edges use the `CodeEdge` shape shown above.

## `sequence`

```json
{"participants":["Browser","API","Database"],"messages":[{"from":"Browser","to":"API","label":"GET /users","kind":"sync"},{"from":"API","to":"Database","label":"find users","kind":"async"},{"from":"API","to":"Browser","label":"200 OK","kind":"return"}]}
```

`kind` is optional and defaults to `sync`; allowed values are `sync`, `async`, and `return`.

## `state`

```json
{"states":["Idle","Running","Done"],"initial":"Idle","transitions":[{"from":"Idle","to":"Running","label":"start"},{"from":"Running","to":"Done","label":"finish"}]}
```

`initial` and transition labels are optional.

## `class`

```json
{"classes":[{"name":"User","fields":["id: uuid"],"methods":["save()"]},{"name":"Admin"}],"relations":[{"from":"Admin","to":"User","kind":"extends"}]}
```

Relation kinds are `extends`, `implements`, `composes`, and `uses`.
