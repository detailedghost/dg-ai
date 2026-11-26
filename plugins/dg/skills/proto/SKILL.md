---
name: proto
description: 'Build a throwaway prototype before committing to a design. The local mode, the default, builds a terminal app for state or logic questions, five UI variations on one route (-n, -o), or a clickable plan walkthrough, with a refine chain and -c resume. Add --ext to prototype inside a live page with the dg-ai-extension. Use for "prototype this" and mock-ups.'
---

First run: the block installs the CLI when it is missing. It prints an upgrade hint when the CLI is too old. Each Bash call works alone:

```bash
dg prototype --help >/dev/null 2>&1 ||
  "${DG_HOME:-$HOME/.local}/bin/dg" prototype --help >/dev/null 2>&1 ||
  { { dg --version >/dev/null 2>&1 || "${DG_HOME:-$HOME/.local}/bin/dg" --version >/dev/null 2>&1; } && echo "run dg upgrade"; } ||
  curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only
```

Call `dg` in every later step. If `dg` alone does not answer, also after the bootstrap, call `${DG_HOME:-$HOME/.local}/bin/dg` instead. If the block prints "run dg upgrade", run `dg upgrade`, then run the step again.

If a step fails, run dg doctor proto prototype install stash.

`dg --version` prints a sha1 of its entry file. If a flag documented here (`--selftest`, `--require-pending`, `--source=`) errors as unknown, the installed binary predates it; refresh it with the curl line above.

# Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

Plain `/dg:proto` runs the **local mode**. It needs no browser extension. Add `--ext` to run the
extension mode: app-native variations planted in a live application page, then review, approve,
and rework in that page. With `--ext`, read [references/extension.md](references/extension.md) and follow it; stop reading this file.

## Flags

**Usage:** `/dg:proto [what to explore] [-n <count>] [-o "<a>,<b>"] [--light] [--publish] [--self-contained] [--series] [-c [<name>]] [--ext]`

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Run the extension mode: scrape a live page, plant app-native variations in it, and wait for the verdict. Needs the extension. The flags below are local mode unless noted. | off (local is the default) |
| `--count <count>` | `-n` | UI variants to build. Local: 1 or more. `--ext`: 1 to 5, the most the URL marker can carry. | 5 local, 5 with `--ext` |
| `--options "<a>,<b>"` | `-o` | Comma-separated directions: one variant per name, no extras. Overrides `--count`. At most 5 with `--ext`. | none |
| `--continue [<name>]` | `-c` | Resume an open refine chain: list chains, or load one and start its next round. | off |
| `--light` | none | Put the sandbox in scratch, wiped on reboot. Plan walkthroughs ignore it. | off (durable sandbox) |
| `--publish` | none | Publish the winning variant as an Artifact after the pick. | off |
| `--self-contained` | none | Render one inline HTML file, no dev server or host app. | off |
| `--series` | none | Keep one tab for a planned set: an approval with no note loads the next prototype. | off |

`-n` and `-o` apply to the UI-variants branch. The logic and plan branches ignore them.
If `-n` and `-o` disagree, `-o` wins. `-n` has no upper limit in the local mode.

**Behavior change.** Plain `/dg:proto` used to run the extension flow. It now runs the local
mode. Add `--ext` to keep the extension flow. `dg proto scrape|plant|cleanup` now needs
`--ext` too: `dg proto --ext plant <plan>`.

## Browser mode

Local mode uses its own server and Playwright fingerprint capture, so it stays local in every `pw.mode`. `auto` never switches `proto`; only `--ext` does.

## Local mode: pick a branch

Identify the question from the prompt and the code, or ask if the user is around.

- **"Does this logic or state model feel right?"** [references/local-logic.md](references/local-logic.md): a tiny interactive terminal app that pushes the state machine through hard cases.
- **"What should this look like?"** [references/local-ui.md](references/local-ui.md): several radically different UI variations on one route, with Approve, Reject and More versions wired to a sentinel. On `more`, build N new variants steered by the note.
- **"Does this whole plan hang together?"** [references/local-plan.md](references/local-plan.md): one clickable walkthrough with a screen switcher across every workflow.

A single state machine or data model is logic. One page or component is UI. A multi-workflow plan, or a prompt that points at a plan or spec file, is plan. When it is ambiguous and the user is away, choose by input and state the assumption at the top. Details: "Choosing a branch" in [references/local-ui.md](references/local-ui.md).

| Task | Read |
|---|---|
| Sandbox, `--light`, `--self-contained`, `--publish`, switcher and endpoint templates, rules for every branch | [references/local-build.md](references/local-build.md) |
| Plan and variant file formats, the `ui` command, what the served page can show | [references/local-formats.md](references/local-formats.md) |
| `-n`, `-o`, selection, refine chain, `--series`, `-c` | [references/local-ui.md](references/local-ui.md) |

## Rendering

A prototype that does not render is worthless. Never load an external URL (CDN script, web font): vendor or inline every dependency. The local mode never reaches the network at run time and never installs a package. The `--ext` mode never writes a browser download; a `~/Downloads/dg-proto/` folder from an older dg is safe to delete. Mount a prototype of an existing app's page in that app, never in a look-alike. Confirm it renders before hand-over, and never install Playwright or download a browser to check. Rules: "Rendering: local first, always" in [references/local-build.md](references/local-build.md).

## Hand over: arm a waiter first

A pick that no process waits on stays unclaimed. Rules:

- **Builder RETURN contract.** A builder subagent that mounts or serves a prototype does one of two things. It blocks on `dg prototype wait <chain> --json` itself, or it returns the required field `wait: dg prototype wait <chain> --json` in its result. A result without it is incomplete.
- **The main loop arms the waiter.** Before it reports the prototype live, the main loop starts `dg prototype wait <chain> --json` in the background. Then it runs `dg prototype status <chain> --require-waiter`. A non-zero exit means no waiter is alive: arm one first. When the builder blocks on wait itself, it reports the pick, so the main loop arms no second waiter.
- **A route behind a login.** Before it returns, the builder runs `dg prototype sign-in <name> --sign-in=<loopback-url>` (or `--state=<pw state name>` for a saved browser state). When `wait` claims an approve, it then reads the layout fingerprint signed in.
- **An unheard pick.** If no waiter is alive when the user clicks, the page says "No agent is listening; tell your agent to check." The pick is saved. Run `dg prototype status <chain>`, then claim it.

Details: "Someone must end up waiting" in [references/local-ui.md](references/local-ui.md).

## Refine chain

`approve C` with no note ends the prototype. `tweak C: <note>` edits C in place. `approve C: <note>` starts a new round from C in the same tab; reuse one chain key. `dg prototype stop <chain>` ends the chain, `/dg:proto -c` resumes it, and `dg prototype status <name>` checks a pick in every shape. Series and example: [references/local-ui.md](references/local-ui.md).

## When done

Keep the answer somewhere durable (commit message, ADR, issue or `NOTES.md`). Details, and claiming an unclaimed pick: [references/local-ui.md](references/local-ui.md).

## When a prototype feeds a planning document

The prototype becomes the source of truth. Keep it in `.agents/prototype/<name>/`, never only in a `--light` sandbox. Implementers follow it completely and surface conflicts. Rules: [references/local-build.md](references/local-build.md).

## Credit

Adapted from [mattpocock/skills `engineering/prototype`](https://github.com/mattpocock/skills/tree/main/skills/engineering/prototype).
