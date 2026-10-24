# Output Format Reference

## TSV (default)

```text
ROWS: 3/150
name	age	city
Alice	30	NYC
Bob	25	LA
Carol	35	CHI
```

## JSON (`--format json`)

One JSON object is emitted per line after the row-count header.

```text
ROWS: 2/150
{"name":"Alice","age":"30","city":"NYC"}
{"name":"Bob","age":"25","city":"LA"}
```

## Markdown (`--format markdown`)

```text
ROWS: 2/150
| name | age | city |
| --- | --- | --- |
| Alice | 30 | NYC |
| Bob | 25 | LA |
```

## Truncation

- `--max-cell N` truncates cells after N characters and appends `...`; the default is 200.
- `--limit N` limits displayed rows; the default is 50.
- Total output never exceeds 64 KB. Truncated output starts with `TRUNCATED: output exceeded 64KB limit (use --limit)`.

## Introspection output

`tables` prints a count, schema, and one table per line. `describe` prints column name, type, nullability, default, and an estimated row count when available. `explain` prefixes the database plan with `PLAN:`. `schema` emits compact JSON with `tables[].columns[]` and `tables[].foreignKeys[]` for downstream tools.

## Token efficiency

- Prefer TSV for exploratory queries.
- Keep `--limit` low until the shape is known.
- Use `--max-cell 100` for large text or JSON columns.
- Use JSON when another tool will select fields programmatically.
