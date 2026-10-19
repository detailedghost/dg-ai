# Arguments

| Form | Effect |
|---|---|
| `/kick` | No arg. Ask one clarifying question, then `/grill-me` derives the feature name and slug from the interview. |
| `/kick <name> --from <path>` | Read the file at `<path>` as the request, for example a design summary. `<name>` is the working title. The interview still runs, seeded with the file. |
| `/kick <name>` | `<name>` is the working title for the interview. The slug still comes from the name the interview settles on. `<name>` is a hint, not a promise of the final slug. |

**Findability note:** `<NNN>` increases for each parked bundle, so two kicks can share a slug under different prefixes. That is not a collision. Each bundle directory is unique. `/pickup` matches either the prefix or a slug substring.
