---
name: overwatch
description: Keep the DeeGee Overwatch board current across parallel chats, route board actions, open the live board, and publish its read-only phone snapshot.
---

# Overwatch

Use Overwatch to maintain one launch lane per chat and a shared phone snapshot.

## Start the chat session

Before using any Overwatch command, make sure this chat has a dg session. If it
does not, run this first from the chat's working directory:

```bash
dg-agent start --agent-identity <name>
```

Use a stable, unique identity. A chat that owns its lane should normally use the
same short name for its identity and lane.

## Keep the board current

Publish one lane per chat. A dedicated Overwatch chat may publish every lane, or
each chat may publish its own lane.

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

Open or focus the live board with:

```bash
dg-agent overwatch open
```

## Handle board actions

Run `dg-agent recv` regularly. Parse its output as JSON, then parse the JSON in
its `body` field. Board actions have this shape:

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

If the command prints `throttled`, stop. Otherwise it prints an HTML path. Read
that file and publish it from this Claude session with the Artifact tool. The
CLI only renders HTML and must never publish the artifact.

Keep `/tmp/ai/dg-overwatch/skill-state.json` as JSON with the returned
`artifactUrl`. Create the artifact only when that URL is absent. On later
renders, update the existing artifact at the stored URL so the phone link never
changes.
