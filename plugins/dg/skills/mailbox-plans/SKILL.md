---
name: mailbox-plans
description: List, inspect, open, resume, or safely restart retained DeeGee mailbox cleanup plans through the connected dg-ai-extension. Use when the user asks to find a saved cleanup plan, continue an in-flight cleanup, edit a draft, preflight an approved plan, or recover stale mailbox work.
---

# Mailbox plans

Use the compiled CLI at `~/.dg/bin/dg-skills`. Bootstrap it on first use:

```bash
DG="$HOME/.dg/bin/dg-skills"
if [ ! -x "$DG" ]; then
  LOCAL_BOOTSTRAP="${CLAUDE_PLUGIN_ROOT:-}/pkg/skills-cli/bootstrap.sh"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
```

Require an installed, connected `dg-ai-extension` mailbox host. Ask the user to
approve each extension-owned **Local CLI connection** page. This approves one
short-lived loopback request, not mailbox mutation or plan acceptance.

## Choose the operation

Run one command and parse its single JSON result from stdout:

```bash
"$DG" mailbox-plans list
"$DG" mailbox-plans list --state draft --state approved --stale only
"$DG" mailbox-plans edit PLAN_ALIAS REVISION_ALIAS
"$DG" mailbox-plans preflight PLAN_ALIAS REVISION_ALIAS
"$DG" mailbox-plans focus PLAN_ALIAS REVISION_ALIAS
"$DG" mailbox-plans resume PLAN_ALIAS REVISION_ALIAS
"$DG" mailbox-plans restart PLAN_ALIAS REVISION_ALIAS
```

- Use `list` first when the target is ambiguous. Lifecycle filters compose with
  `--stale all|only|exclude`; repeated `--state` values mean any listed state.
  Narrow further only with sanitized `--provider`, `--surface`, or `--account`
  values returned by an earlier list.
- Follow each row's `nextAction`. Open Draft with `edit`, Approved with
  `preflight`, active In flight with `focus` or `resume`, and Stale with
  `restart`.
- Treat `check_required` as blocked until the explicit provider probe completes.
- Treat `restart` as recovery, not approval. It always rescans and creates fresh
  bindings. If canonical content changed, report the new Draft and require
  **Accept Revision** again.
- Never retry a timed-out, canceled, conflicting, or interrupted mutation
  blindly. List again and follow the returned next action.

Keep stdout machine-only. Do not echo JSON, aliases, or errors to stderr unless
the user needs a concise status. Never place raw message text, provider
locators, account identifiers, subjects, snippets, or temporary bindings in
chat, files, URLs, logs, or command arguments. Expired plans must be treated as
absent. A disconnected chat may leave a recoverable sanitized Draft; list again
instead of reconstructing it from raw mailbox data.
