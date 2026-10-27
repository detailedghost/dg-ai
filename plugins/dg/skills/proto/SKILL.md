---
name: proto
description: Build a throwaway prototype before committing to a design. The local mode, which is the default, routes to a runnable terminal app for state and logic questions, five UI variations toggled from one route (set the count with -n or name them with -o), or a clickable walkthrough across a plan's workflows, with a refine chain and -c resume. Add --ext to prototype app-native variations inside a live page with the dg-ai-extension instead. Use when the user wants to prototype, sanity-check a data model or state machine, mock up a UI, explore design options, review or rework alternatives on a real page, or says "prototype this", "show me all the workflows", "let me play with it". Flags: --ext, -n, -o, -c, --light, --publish, --self-contained, --series.
---

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills prototype --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor proto prototype stash.

`dg-skills --version` prints a sha1 of its entry file. If a flag documented here (`--selftest`, `--require-pending`, `--source=`) errors as unknown, the installed binary predates it; refresh it with the curl line above.

# Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

Plain `/dg:proto` runs the **local mode**. It needs no browser extension. Add `--ext` to run the
extension mode: app-native variations planted in a live application page, then review, approve,
and rework in that page. The `--ext` mode is documented in [references/extension.md](references/extension.md).

## Flags

**Usage:** `/dg:proto [what to explore] [-n <count>] [-o "<a>,<b>"] [--light] [--publish] [--self-contained] [--series] [-c [<name>]] [--ext]`

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--ext` | none | Run the extension mode instead of the local mode: scrape a live page, plant app-native variations in it, and wait for the verdict from the dg-ai-extension. Needs the extension. The other flags below apply to the local mode unless noted. | off (local is the default) |
| `--count <count>` | `-n` | Number of UI variants to build. Local: any count of 1 or more. `--ext`: 1 to 5 — the plan travels in the planted page's URL marker, and 5 is the largest comparison that marker can carry. | 5 local, 5 with `--ext` |
| `--options "<a>,<b>"` | `-o` | Comma-separated directions to build. One variant per name, exactly those, no extras, each name is its label. Overrides `--count`. In `--ext` it takes at most 5 names. | none |
| `--continue [<name>]` | `-c` | Resume an open refine chain: list open chains, or load the named one and start its next round. Local mode, UI variants branch. | off |
| `--light` | none | Put the sandbox in scratch, wiped on reboot. Local mode. Plan walkthroughs ignore it. | off (durable sandbox) |
| `--publish` | none | Publish the winning variant as an Artifact after the pick. Local mode. | off |
| `--self-contained` | none | Render one inline HTML file, no dev server or host app. Local mode. | off |
| `--series` | none | Keep one tab for a planned set of prototypes: an approval with no note loads the next prototype in the same tab. Local mode. | off |

`-n` and `-o` apply to the UI-variants branch. The logic and plan branches ignore them.
If `-n` and `-o` disagree, `-o` wins. `-n` has no upper limit in the local mode.

**Behavior change.** Plain `/dg:proto` used to run the extension flow. It now runs the local
mode. Add `--ext` to keep the extension flow. `dg-skills proto scrape|plant|cleanup` now needs
`--ext` too: `dg-skills proto --ext plant <plan>`.

## Pick a mode

- No `--ext`: local mode. Continue below.
- `--ext`: read [references/extension.md](references/extension.md) and follow it. Stop reading this file.

## Local mode: pick a branch

Identify which question is being answered from the prompt, the surrounding code, or by asking
if the user is around.

- **"Does this logic or state model feel right?"** Read [references/local-logic.md](references/local-logic.md). Build a tiny interactive terminal app that pushes the state machine through cases that are hard to reason about on paper.
- **"What should this look like?"** Read [references/local-ui.md](references/local-ui.md). Build several radically different UI variations on one route, switchable from a floating bar, with Approve and Reject buttons wired to a sentinel.
- **"Does this whole plan hang together?" or "show me all the workflows"** Read [references/local-plan.md](references/local-plan.md). The input is a plan or design seed that spans several workflows. Build one clickable walkthrough with a screen switcher across every workflow, not N variants of one page.

The three branches produce very different artifacts. A single state machine or data model is
logic. One page or component whose look is in question is UI. A multi-workflow feature or plan
whose question is whether the workflows cohere end to end is plan. A prompt that points at a
plan or spec file, or says "prototype this plan", is the plan branch. When it is ambiguous and
the user is not reachable, choose the branch that matches the input (a backend module is logic,
a page is UI, a plan or spec is plan) and state the assumption at the top of the prototype.

| Task | Read |
|---|---|
| Sandbox location, `--light`, `--self-contained`, `--publish`, and rules for every branch | [references/local-build.md](references/local-build.md) |
| Plan and variant file formats, the `ui` command, and what the served page can show | [references/local-formats.md](references/local-formats.md) |
| Variant count (`-n`), named options (`-o`), selection, refine chain, `--series`, `-c` | [references/local-ui.md](references/local-ui.md) |
| Shipped switcher and endpoint templates | [references/local-build.md](references/local-build.md) |

## Rendering: local first, always

A prototype that does not render is worthless. Never `<script src>` or `<link href>` an external
URL (CDN scripts, web fonts) in a prototype: it renders blank when the network is blocked.
Vendor or inline every dependency, or hand-render to plain HTML and CSS.

**The local mode never reaches the network at run time.** Never install a package or framework, and
never fetch one from the network, to satisfy this: use what the project already has installed. If a
dependency is genuinely missing, stop and name the one command the user should run (the same way the
browser skill asks for `pw install chrome`) and let them run it. `--ext` mode never writes a browser
download either: the extension hands scrape and plant results straight to the CLI over the paired
dg-daemon session. A `~/Downloads/dg-proto/` folder from an older `dg-skills` version is safe to
delete; nothing reads or writes it anymore.

A prototype of an existing app's UI renders **in that app**. When the thing being prototyped is a
page, panel, dialog, or component of a web app in the repo, mount the variants in the real running
app (UI sub-shape A in [references/local-ui.md](references/local-ui.md)). Never rebuild the app's chrome as a standalone
look-alike: the user then judges the copy, not the design.

With no host app, or with `--self-contained`, serve the content on the `prototype serve` page
with `dg-skills prototype ui`. Prose, tables, code, and compare cards are plain HTML inside a
variant, so no other viewer is needed. See [references/local-formats.md](references/local-formats.md).

Verify the page renders before handing it over. Load it (an already-installed Playwright, through
the `pw` skill or an MCP tool, or a headless check of the produced HTML) and confirm the real
content is present — never install Playwright or download a browser for this check. Never ask "does
this look right?" about a page you have not confirmed renders.

## Refine chain

`approve C` with no note ends the prototype. `tweak C: <note>` edits C in place in the current
round, builds no new variants, and shows C again for a pick. `approve C: <note>` makes C the base
of a new round: `-n` new variants that change only what the note asks. Every round shows in the
same browser tab: reuse one chain key. The chain ends on an approval with no note, or on "done"
or "stop" (`~/.dg/bin/dg-skills prototype stop <chain>`). Resume a later session with `/dg:proto -c`.
`~/.dg/bin/dg-skills prototype status <name>` is the one command for checking a pick, in every
shape: local, a chain, a series, in-app, and an unclaimed `--ext` verdict.

**Series exception.** When prototypes run one after another (a planned set, such as one screen per
prototype), keep the same tab for the whole set: run each with `--series` and one shared
`--chain`. An approval with no note then reloads the same tab with the next prototype instead of
closing it. Run `prototype stop <chain>` after the last one.

Example, a form and then its buttons:

1. `/dg:proto signup form` builds round 1, variants A to E.
2. `approve C: organize the buttons` builds round 2: five variants of C with only the buttons changed.
3. `approve B: tighten the spacing` builds round 3 from round 2 B.
4. `approve D` ends the chain. `--publish` publishes round 3 D only.

Details: [references/local-ui.md](references/local-ui.md).

## When done

The answer is the only thing worth keeping from a prototype. Capture it somewhere durable (commit
message, ADR, issue, or the `NOTES.md` next to the prototype) along with the question it answered.
If the user is around, that capture is a quick conversation. If not, leave the placeholder so they,
or you on the next pass, can fill in the verdict before deleting the prototype.

Returning to a prototype rather than building one? A UI prototype's pick may already be sitting
unclaimed. See "Claim an outstanding pick" in [references/local-ui.md](references/local-ui.md) before assuming the verdict was lost.

## When a prototype feeds a planning document

If a planning document (a `/dg:spec` spec, a plan, a `/dg:prd` deliverable) references the
prototype's outcome, the prototype stops being throwaway for the life of that plan and becomes the
source of truth for the design it settled.

1. **Keep the asset available.** The prototype must live in the durable `.agents/prototype/<name>/` location, never only in the `--light` scratch sandbox, which is wiped on reboot while the plan is still open. If it was built with `--light`, copy it into `.agents/prototype/<name>/` before referencing it. Record its path, and the winning variant key for a UI prototype, in the planning document.
2. **Follow it completely.** Agents that implement a prototyped decision reproduce the prototype's design and feature set faithfully. Do not silently drop features or re-decide the look or flow it already resolved.
3. **Ask when it does not fit the code.** Where the prototype conflicts with the current code design (data shape, existing components, framework limits it could not see), surface the mismatch instead of diverging or force-fitting. Ask directly when interactive, or escalate to the orchestrator inside a workflow that forbids prompts.

## Credit

Adapted from [mattpocock/skills `engineering/prototype`](https://github.com/mattpocock/skills/tree/main/skills/engineering/prototype).
