---
name: verify
description: Review finished work before it lands. Capture before-and-after screenshots of each change at desktop and mobile, light and dark, per role, including scrolled pages and open menus, then show them side by side with test results and an accessibility summary. Dante approves, rejects, or tweaks each item from a picker. Use when an agent has finished a branch, worktree, or page and a person needs to see it, or when the user says "verify this", "show me before and after", or "let me approve the change".
---

First run: install or refresh the CLI when it is missing or too old. Every later call uses the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills verify --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.1/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor verify.

# Verify

`/dg:proto` compares variants of a design that does not exist yet.
`/dg:verify` reviews a change that is already built.
Each item has a before and an after. A prototype, when one exists, is a third column.

The review is one local page.
Dante picks per item: Approve, Reject with a note, or Tweak with a note.
The agent claims that verdict with `verify status` and `verify wait`.
Reject and Tweak go back to the owning agent.
`verify rerun` recaptures only those items and reloads the same tab.

## Flags

**Usage:** `/dg:verify [<name>] [--manifest <file>] [--engine <http|playwright>] [--items <ids>] [--port <n>] [--timeout <sec>] [--no-open] [--no-capture] [--json] [--dir <path>]`

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--manifest <file>` | none | Path to the review manifest. Required for `verify start`. | none |
| `--engine <http\|playwright>` | none | `playwright` takes real viewport screenshots. `http` records HTML only and labels every figure as an HTML fetch. | `playwright` |
| `--items <ids>` | none | Comma-separated item ids for `verify capture`. `verify rerun` chooses the rejected and tweaked items itself. | all items |
| `--port <n>` | none | Port for the review page. `0` asks the OS for a free port. | `4377` |
| `--timeout <sec>` | none | How long `verify wait` blocks for a finished verdict. | `900` |
| `--no-open` | none | Do not launch a browser. Print the local URL. | off (opens the page) |
| `--no-capture` | none | `verify start` serves the page without capturing. | off (captures) |
| `--json` | none | Print `status` and `wait` as JSON. | off |
| `--dir <path>` | none | Session directory. The default is `.agents/verify/<name>/` in the current repo. | that directory |

## Build the manifest

Write a JSON file. Every URL must be loopback (`127.0.0.1`, `localhost`, or `::1`).
Do not point at production.
Do not put real sessions, passwords, or access tokens in headers or cookies.
Use seed roles only.

```json
{
  "name": "settings-nav",
  "stackUrl": "http://127.0.0.1:3000/",
  "tests": { "summary": "12 passed", "passed": 12, "failed": 0 },
  "items": [
    {
      "id": "settings",
      "title": "Settings",
      "owner": "dg:implementer",
      "beforeRef": "master",
      "afterRef": "feat/settings-nav",
      "beforeUrl": "http://127.0.0.1:4001/settings",
      "afterUrl": "http://127.0.0.1:4002/settings",
      "targetUrl": "http://127.0.0.1:4321/",
      "roles": [
        { "id": "admin", "headers": { "x-seed-role": "admin" } },
        { "id": "member", "headers": { "x-seed-role": "member" } }
      ]
    }
  ]
}
```

`owner` is the agent who owns the after side. Name them the way the work was assigned. See [references/owners.md](references/owners.md).

`beforeRef` and `afterRef` are labels (a branch or a worktree).
This command does not check out branches or boot apps.
Start the before stack and the after stack yourself, then put their URLs in the manifest.
`stackUrl` is the after stack Dante can click.
`targetUrl` is optional.
Set it only when a prototype page is already running.
The column says there is no prototype target when the field is absent.

`tests` is the suite result for the change. A `cmd` array is an argv, never a shell. A `summary` is enough when the suite already ran.

Capture details, viewports, and the accessibility check: [references/capture.md](references/capture.md).

## Run the review

```bash
~/.dg/bin/dg-skills verify start settings-nav --manifest=review.json --no-open
~/.dg/bin/dg-skills verify wait settings-nav --json
```

`start` captures, serves the page, and stays running. Leave that process up. The page polls a reload token, so the tab stays open across reruns.

Dante uses the picker on each item. Reject and Tweak require a note. Approve may include one.

`status` prints `pending`, `all-approved`, or `needs-rework` without consuming the verdict. `allApproved` is true only when every item is Approve.

`wait` blocks until every item has a pick, then claims the verdict. A second `wait` reprints that claim. It blocks again only after `rerun` clears the claim.

## Send notes back and rerun

When `wait` reports `needs-rework`, read `notifications` from `verify status --json`.
Each entry has `itemId`, `owner`, `action`, and `note`.
Deliver that note to `owner` as their next instruction.
The file is also under `.agents/verify/<name>/notify/<itemId>.json`.
This command does not message anyone itself.

After the owner updates the after stack:

```bash
~/.dg/bin/dg-skills verify rerun settings-nav
```

`rerun` recaptures only the rejected and tweaked items, clears those picks, and bumps the reload token.
The open tab reloads.
Approved items stay approved and are not captured again.
When nothing needs rework it prints `nothing-to-recapture`.

## Local only

The review page is static files from the CLI: `/verify.js` and `/verify.css`.
The HTML has no inline script and no inline style.
The server sends a Content-Security-Policy that allows only `'self'` for scripts, styles, images, and connections.
Nothing is loaded from a CDN.

Screenshots and verdicts stay in `.agents/verify/<name>/`.
That directory is gitignored. Do not commit them.
Do not copy real user data into the manifest or the fixture.

The page does not inject a script into the app under review. Capture navigates and screenshots. The app's own CSP is left alone.
