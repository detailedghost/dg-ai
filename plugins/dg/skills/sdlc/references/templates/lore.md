# Lore Template (Docs stage)

> [Common directives.] Read Purpose, Scope, Slice headings in spec. Check existing docs (docs/, README). Update documentation for changed files below. No public API/function without doc comment, README updated if public interface changed. Do NOT modify the spec.
> Changed files: [list]
> **Decisions:** skip this block when `.agents/decisions/README.md` is absent. Otherwise:
>
> 1. Run `dg adr relevant <changed files> --json`. When behavior changed, update each matching ADR and decision. Single-quote each path and write an embedded single quote as `'\''`.
> 1. Run `dg adr index`, then `dg adr lint --changed`. It must exit 0 before the docs commit.
> 1. Never write a new ADR and decision pair. For a decision that passes the three gates in `/dg:adr` and has no record, emit `⚑ RATIFY: new ADR "<title>" — write it now | skip — <recommendation>` for the main loop to relay.
>
> **Learnings:** promote each durable rule, trap or standard this feature set into the matching `.agents/school/<topic>.md` as one dated line (`- [YYYY-MM-DD] ...`), deduplicated against what is there. A rule that is a decision goes through the decision pair above instead. At the file's cap, prune the oldest lines.
