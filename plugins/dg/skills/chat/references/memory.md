# Chat memory verbs

Full text moved out of SKILL.md. Verb summary stays in SKILL.md.

## Verbs

Four verbs read and write this agent's own long-term memory. The CLI opens
`agents/memory.db` in the dg state root itself (`~/.local/state/dg/agents/memory.db`
on Linux; `resolveDgPaths` gives the other OSes), so every verb works with no
daemon running at all.

- `memory write <title> [body] [--kind <kind>] [--workset <label>] [--identity
  <name>]` — record one memory. The body is the argument, or stdin when left
  off. The same title again replaces the earlier memory. A blank title or body
  is refused. Prints the memory id. A title starting with `-` needs a `--`
  separator first: `memory write -- "-1 on call" "body"`. Replace and size-cap
  rules: [details.md](details.md).
- `memory search [query] [--workset <label>] [--identity <name>] [--limit <n>]
  [--offset <n>] [--full]` — find this agent's memories, most relevant first.
  Free text only: punctuation FTS5 would choke on is dropped, so no query is a
  syntax error; a query of only punctuation returns nothing. With no query it
  lists the most recent first. One line per hit — id, date, workset,
  title — unless `--full` prints the whole record as JSON, one per line. Pages
  default to 20 hits and cap at 100.
- `memory read <id> [--full]` — print one memory as text, or the whole record
  as JSON with `--full`.
- `memory forget <id>` — remove one memory.

`read` and `forget` both exit 1 on an id that is not there.

The agent identity comes from the session file on disk: the sole session
registered from this working directory, `-s <id>` for a specific one, or
`--identity <name>` to override either.

Writing the same title again replaces what this agent knew under that title, and leaving out `--kind` leaves an existing kind alone. The body is capped at `CHAT_MAX_MESSAGE_BODY_BYTES`, the same bound `send` puts on a message body.
