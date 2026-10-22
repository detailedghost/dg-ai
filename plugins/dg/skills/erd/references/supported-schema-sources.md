# Supported Schema Sources

`/dg:erd` collects DB schema live-first, static-fallback. This is the precedence and format
detail behind `src/erd/schema-live.ts` and `src/erd/schema-static.ts` (`src/erd/index.ts`'s
`collectDbPartial`).

## Live-first

`collectLiveSchema` re-enters the current compiled `dg-skills` binary with `db connections`
to enumerate connection names, then issues exactly one `db schema <conn>`
call per candidate connection in order — never `db describe` in a loop. Reachability is
determined solely by whether that single call succeeds or fails: a failing call means the
connection is unreachable/unusable and collection moves to the next candidate. The first
connection whose `db schema` call succeeds wins outright and no static format is consulted.

## Static fallback

If live collection returns zero nodes (no reachable connection, or none configured),
`collectStaticSchema` walks the scope for four static formats, in this precedence order:

1. **Prisma** — `schema.prisma`, parsed for `model` blocks (fields, types, relations).
2. **EF Core migrations** — a `Migrations/` directory of `*.cs` files (capitalized, unlike
   the lowercase SQL migration convention below — this is how the two formats stay
   distinguishable when both are present in the same scope).
3. **Raw SQL migrations** — `**/migrations/**/*.sql` or `**/db/migrations/**/*.sql`, parsed
   for `CREATE TABLE` statements and foreign keys.
4. **dbt `sources.yml`** — `**/models/**/sources.yml(.yaml)`, parsed for source table
   declarations (columns only — dbt sources carry no edge/FK information).

**First non-empty result wins, not first present format.** Presence alone doesn't decide
it: if a Prisma schema exists but parses to zero nodes (malformed, oversized, no models),
`collectStaticSchema` falls through to EF, then SQL, then dbt. Every format that is present
on disk gets attempted in order until one parses to a non-empty node set; if all present
formats parse to zero nodes, the result falls back to whichever was attempted last, so
evidence still surfaces the skip reasons.

When more than one static format is present but only one is used, `renderMarkdown` includes
a one-line note in the DB-schema section naming the format used and which others were found
but skipped (e.g. `"Static schema parsed from: prisma/schema.prisma (dbt sources.yml also
present but not used — see limitations)"`). The note is omitted when only one static format
was found, or when the schema came from a live connection.
