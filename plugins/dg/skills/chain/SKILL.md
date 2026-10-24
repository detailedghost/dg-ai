---
name: chain
description: Render and wire a batch of PRs/MRs as a clean unicode-arrow stack when they're sequentially dependent — retargets base branches so the provider (GitHub or GitLab) blocks merge until the upstream lands, and renders a "## Stack (merge order)" block. PRs/MRs with no real dependency get a separate flat "Related PRs" list instead of a fake arrow. Callable standalone in any chat, or from a batch-PR skill mid-pipeline.
---

# Skill: chain

## Runtime and skill paths

Resolve the compiled CLI before running any command:

```bash
~/.dg/bin/dg-skills chain --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor chain proxy.

Repeat this resolution in every fresh shell, including resumed and delegated
commands; shell variables do not persist between tool calls. Use the host's
existing narrow approvals for the operation and honor permission already granted
in this session. Do not edit permission files or assume the compiled binary grants
blanket approval to its subcommands.

Resolve cross-skill instructions from this installed tree using sibling paths
(`../<skill>/SKILL.md` from this directory). If an unmigrated skill is missing, use
only an explicitly configured personal skill root
(`DG_PERSONAL_SKILLS_DIR/<skill>/SKILL.md`). Report missing instructions rather
than assuming a private checkout or cache location. If delegating, resolve host
personas through the host registry or explicit `DG_PERSONAS_DIR` / `DG_AGENTS_DIR`
configuration, and pass real absolute instruction paths to delegates.
The plugin ships its personas in `agents/` (Claude Code loads them as
`dg:<name>`; `dg-skills proxy` embeds them), so use those when the host has none.

Run `~/.dg/bin/dg-skills chain --help` for the full usage.

A **layer** is one ref, or a comma-separated set of mutually-independent refs
(`"101,102"`). Positional layers form a dependency chain, base-first:
`layer1 → layer2 → ... → --target` (default target `main`). Refs can be PR/MR numbers,
`owner/repo#N` (required for cross-repo autolinking), or pre-PR/MR branch names.

The chain command works against either GitHub or GitLab — it goes through the VCS provider
layer (`gh` or `glab` under the hood, auto-detected from the repo) rather than
hard-coding one tool, so every subcommand below behaves the same on both.

| Subcommand | Does |
|---|---|
| `~/.dg/bin/dg-skills chain render <layers...>` | Prints the rendered block only — paste it wherever needed (a board note, a manual PR edit). |
| `~/.dg/bin/dg-skills chain plan <layers...>` | Dry run: rendered block + which base retargets would happen, with no provider calls. Show the full output before applying the plan. |
| `~/.dg/bin/dg-skills chain base <layers...>` | Runs the base/target-branch retargets only. |
| `~/.dg/bin/dg-skills chain apply <layers...>` | Retargets bases, then idempotently upserts the rendered block into every PR/MR's body. Safe to re-run. |

**Usage:** `/dg:chain <render|plan|base|apply> <layers...> [--target <branch>] [--mark <ref>] [--repo owner/repo] [--independent ref1,ref2] [--native]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--target <branch>` | none | Branch the chain merges into. | `main` |
| `--mark <ref>` | none | Bold this ref as "this PR" in the legend. | none |
| `--repo owner/repo` | none | Repository for bare PR numbers. | current repo |
| `--independent ref1,ref2` | none | Bystander PRs with no dependency. They render in a separate list. | none |
| `--native` | none | `plan` and `apply` only. Also link the chain through `gh stack link`. Needs the external extension. | off |

`--independent ref1,ref2` lists bystander PRs/MRs that have no dependency relationship at
all — they render under a separate `## Related PRs (independent — mergeable in any
order)` heading, never with an arrow. `--mark <ref>` bolds that ref as "this PR" in the
legend. A single layer with no `--independent` renders as all-independent (no fake
one-node stack).

`--native` additionally attempts `gh stack link` after base retargeting and
before the body updates. It needs an external GitHub CLI extension providing
that command. The extension is optional and its
availability and behavior depend on that external project. A missing extension
or failed link is reported on stderr; body updates still continue.

Only linear, single-repo chains qualify (every layer a single ref, no
`owner/repo#N` refs, no `--repo`). Fan-out layers and cross-repo chains skip native
linking with a reason and still update the markdown block. `~/.dg/bin/dg-skills chain plan
<layers...> --native` reports eligibility without calling `gh`. GitLab has no
native stacking capability: `~/.dg/bin/dg-skills chain apply <layers...> --native` refuses with
status 4 before any mutation, while the corresponding plan explains the skip.

## Workflow

1. Run `~/.dg/bin/dg-skills chain plan <layers...> [--native]` and show its full output,
   including the rendered body and base changes, before apply.
2. Confirm that the host's required approval covers those mutations, honoring
   existing session grants. If approval is still required, obtain it for this
   concrete plan. Run `~/.dg/bin/dg-skills chain apply <layers...> [--native]` within that scope.
3. Report any skipped or failed operation. Retarget failures are logged and later
   retargets continue. Body fetching or writing stops on the first failure;
   earlier updates remain. Re-running replaces only the managed marker block and
   preserves surrounding body text.

Branch names support rendering and planning before PRs/MRs exist. Applying body
updates requires existing numeric refs (bare, `#N`, or `owner/repo#N`).

## When to reach for this

Any time a batch of PRs being opened or already open has a real dependency between
two or more of them — same repo or cross-repo. If everything in the batch is mutually
independent, use the ordinary batch workflow; no dependency stack is needed.
