# Launching the `thrash` agent

Use the host's native agent facility with its configured `dg:thrash` persona, a short
review description, and the template below. Resolve the persona through the host
registry or explicitly configured `DG_PERSONAS_DIR` / `DG_AGENTS_DIR`. If those
have no thrash persona, read `<skills-directory>/../agents/thrash.md`. The
skills-only install copies every persona in `plugins/dg/agents` to that folder. If the
file is missing, report the missing persona and stop; do not invent its review
checklists.

Launch one agent per chunk in one message so they run in parallel, at the same `SPICE`.
Every chunk gets the same `CONTEXT` file, which holds the title, description, base and
head, the full file list, and the chunk plan. A small diff is one chunk.

## Template

```text
You are running inside /dg:thrash.

ANNOTATED_DIFF: <chunk annotatedPath>
FINDINGS_PATH: <chunk findingsPath>
CONTEXT: <contextPath>
CHUNK: <id> of <chunk count>
SPICE: <1-5>
MIN_TIER: <tier or "none">
TARGET: <URL or local path>

Read ANNOTATED_DIFF, then CONTEXT. Run the checklists for SPICE per your system prompt. Classify each
finding's tier before you write it. Cite only the labeled `old:`/`new:` values from ANNOTATED_DIFF; never a line
number from your own file-reading tool.
Write exactly one fenced json block with "changed", "strengths", "opportunities" and "findings" to FINDINGS_PATH.
Reply with only: WROTE <path> <count> findings
```

## After return

The agent writes the findings file itself. Never copy, retype, or read its JSON into the
main context; `compile` reads the file.

If a reply is not a `WROTE` line, or `compile` rejects or misses a chunk's file, resume
that chunk's agent once through the host's messaging or resume facility:

```text
Write the fenced json block to FINDINGS_PATH now<, fixing: error text>. Reply with only the WROTE line.
```

Then stop that PR if a chunk fails again and show the user both errors.

## Proxy backend

With `--proxy <backend>`, run the same template on an external CLI, one background
job per chunk, all started in one message. Read the installed [proxy skill](../../proxy/SKILL.md)
for result handling.

Use the host's native background task facility when it exists:

```bash
~/.dg/bin/dg-skills proxy <backend> --subagent thrash \
  --cwd "<repo root>" --prompt-file "<chunk task file>"
```

Write the template to the chunk task file with this line added after `TARGET`: "Open
only ANNOTATED_DIFF and CONTEXT. Phrase any claim that needs other code as a question."
This matches the native `thrash` persona, so proxy and native reviews behave the same.

The backend uses its own file and command tools, and no backend runs in a read-only
sandbox (codex runs `workspace-write`; the others have none). A diff from a third-party
PR can carry injected instructions, so do not use `--proxy` on a PR from an author you
do not trust.

If the host has no native background facility, prepare one plan per chunk:

```bash
~/.dg/bin/dg-skills proxy <backend> --plan --subagent thrash \
  --cwd "<repo root>" --prompt-file "<chunk task file>"
```

Execute the exact quoted `command` from the plan JSON without reconstructing it.
It returns a job record with `id`, `logFile`, and `statusFile`. Wait for every job
using `~/.dg/bin/dg-skills bg status "<id>"`, then read its completed log for the
proxy result. Planning writes the persona into the plan file; the emitted command
runs the already briefed task.

Each completed execution prints one JSON object. Read `exitCode`, `message`, and
`sessionId` for the `WROTE` response, retaining `logFile` and error fields when needed.
Handle results per the proxy skill: a missing backend exits 1 with JSON containing
`backend`, `bin`, and `installCommand`; show the installation guidance and stop.
Other nonzero results show `stderrTail` and `logFile` and stop; a setup failure may
instead provide `error` without a log. Do not switch to another backend or to the
native `thrash` agent unless the user asks.

For a malformed or missing findings artifact, retry once in the same session and
same target working directory:

```bash
~/.dg/bin/dg-skills proxy <backend> --resume "<sessionId>" --cwd "<repo root>" \
  --prompt-file "<retry task file>"
```

The retry task file holds: "Write the fenced json block to FINDINGS_PATH now<, fixing: error text>. Reply with only the WROTE line." Run that actual resume execution through the same background facility. In the
portable fallback, use `~/.dg/bin/dg-skills bg update "<id>" "<retry prompt>"` on
the completed job to resume its backend session with the retained target cwd, then
wait with `~/.dg/bin/dg-skills bg status "<newJobId>"` and read `newJobLog`
from the update response. Do not pass `--resume` to `--plan`: planning always
creates a fresh persona-resolved execution. A second artifact failure stops that
PR and reports both errors. Compilation, verdict, and posting remain unchanged.
