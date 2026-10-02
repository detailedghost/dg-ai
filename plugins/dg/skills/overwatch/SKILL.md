---
name: overwatch
description: Keep the DeeGee Overwatch board current across parallel chats, route board actions, open the live board, and publish its read-only phone snapshot.
---

# Overwatch

Use Overwatch to maintain one launch lane per chat and a shared phone snapshot.
One dedicated Overwatch chat is the authoritative publisher for the board and
phone artifact. Other chats may report status to that identity with
`dg-agent send` or use the public board mutation commands directly. The daemon
notifies the authoritative publisher whenever any chat changes the board.

## Start the chat session

Before using any Overwatch command, make sure this chat has a dg session. If it
does not, run this first from the chat's working directory:

```bash
dg-agent start --agent-identity <name>
```

Use `overwatch-board` as the stable identity for the authoritative publisher.

## Keep the board current

Publish every lane from the authoritative Overwatch chat. Keep `dg-agent recv`
running with a bounded blocking timeout so status reports and board actions are
processed continuously.

```bash
dg-agent overwatch set <chat> --task "<task>" --stage <review|ci|e2e|merge|done> --mr "<!number>" --eta "<eta>" --next "<what you need>" --url "<claude session url>"
```

Leave out optional fields that do not apply. Use `--background` for a background
agent. Update a lane whenever its status changes, and use these lifecycle
commands when appropriate:

```bash
dg-agent overwatch merged <mr> "<title>"
dg-agent overwatch launch --go-live <iso> --go-no-go <iso>
dg-agent overwatch remove <chat>
```

After every successful `set`, `merged`, `launch`, or `remove` mutation, mark the
newest board state for phone publication. A direct mutation from another chat
arrives with `overwatch.event` set to `board-changed` and marks the state the
same way.

Open or focus the live board with:

```bash
dg-agent overwatch open
```

## Handle board actions

Run the documented receive command in an explicit loop. Exit code 5 is the
expected bounded timeout and starts the next iteration. Any other nonzero exit
stops the loop as an error.

```bash
while true; do
  if received="$(dg-agent recv --block --timeout 30000)"; then
    process_overwatch_message "$received"
  else
    status=$?
    if [ "$status" -ne 5 ]; then
      exit "$status"
    fi
  fi
  publish_newest_snapshot_if_due
done
```

Parse successful output as JSON, then parse the JSON in its `body` field. Board
actions have this shape:

```json
{"overwatch":{"chat":"print","action":"reply|approve|reject","note":"optional text"}}
```

Relay the action and note to the named chat without rewriting them. When the
chat name is also its agent identity, use `dg-agent send --to <chat> <message>`.
If this chat owns that lane, handle the action directly.

## Publish the phone snapshot

Render at most once every two minutes:

```bash
dg-agent overwatch snapshot --json | dg-skills overwatch-snapshot --input - --throttle-key board
```

If the command prints `throttled`, record its reported retry time and continue
the receive loop. Otherwise it prints an HTML path. Read that file and publish
it from this Claude session with the Artifact tool. The CLI only renders HTML
and must never publish the artifact.

The snapshot CLI creates or repairs
`/tmp/ai/dg-overwatch/skill-state.json` with mode 0600. Keep the returned
`artifactUrl` in that JSON file without replacing the file. Create the artifact
only when that URL is absent. On later renders, update the existing artifact at
the stored URL so the phone link never changes.

Keep one pending-publication flag and one next-attempt time. Every mutation
coalesces into that single pending item, so it always represents the newest
board. Continue processing status reports and board actions while throttled.
When the next-attempt time arrives, render the current board, publish it, and
clear the flag only after publication succeeds. A newer mutation during render
or publication leaves the flag set for another pass.
