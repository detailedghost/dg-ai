# ERD Markdown Output

`erd generate` without `--type` writes the combined architecture document:

1. Scope summary and an optional truncation note.
2. Nested directory tree.
3. Module import-degree table.
4. Fenced Mermaid import flowchart.
5. Fenced Mermaid schema ER diagram when a schema exists.
6. Code-to-schema cross-links.
7. A capped evidence preview; the `.json` sidecar stays complete.

The combined document uses `graph LR` for imports and `erDiagram` for schemas. `generate --type flow` keeps only the Import Graph section. `generate --type er` keeps only the Database Schema section. `erd render` always writes one heading and one fenced Mermaid block for its selected type. `--html` does not change the Markdown or JSON artifacts; it adds the matching `.html` file.

Dynamic Markdown cells and Mermaid labels are escaped separately. Import edges are deduplicated by `(from, to, kind)`. The readable evidence preview is capped at ten records per type while the JSON sidecar remains complete.
