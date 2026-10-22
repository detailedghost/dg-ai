---
name: ticket
description: Create a Jira ticket via the Atlassian MCP, using the registered site, project, assignee, sprint field and issue types for this machine. Use when the user says "make a ticket", "file a Jira issue", "create a task/story/bug for X", or /dg:ticket.
allowed-tools: Bash(~/.dg/bin/dg-skills:*), searchJiraIssuesUsingJql, lookupJiraAccountId, createJiraIssue
---

# Skill: ticket

Create a Jira issue through the Atlassian MCP. Every site-specific value (cloud id,
project key, default assignee, sprint custom field, issue type ids) comes from the
`ticket/jira` credential's metadata — never from this file. Nothing here identifies a
real organization, project or person.

First run: install or refresh the CLI when it is missing or too old. Every later call uses
the literal path, so each Bash call works alone:

```bash
~/.dg/bin/dg-skills credentials --help >/dev/null 2>&1 ||
  curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.19.0/pkg/skills-cli/bootstrap.sh | sh -s -- --cli-only
```

If a step fails, run ~/.dg/bin/dg-skills doctor credentials.

## Usage

**Usage:** `/dg:ticket <summary text> [--type <name>] [--assignee <email>] [--sprint <name|id>] [--no-sprint] [--project <KEY>] [--description <text>]`

## Flags

| Flag | Short | Effect | Default |
|---|---|---|---|
| `--type <name>` | none | Issue type name, must be a key in the registered `issueTypes` map | the registered default issue type |
| `--assignee <email>` | none | Resolve this email to an accountId via `lookupJiraAccountId` instead of the registered default | registered `assignee` meta |
| `--sprint <name\|id>` | none | Use this sprint instead of the active one | latest (active) sprint on the registered project's board |
| `--no-sprint` | none | Create with no sprint field set | off |
| `--project <KEY>` | none | Override the registered default project | registered `project` meta |
| `--description <text>` | none | Issue description (plain text/markdown) | none |

## Registration

Before first use, register the `ticket/jira` credential once:

```bash
~/.dg/bin/dg-skills credentials set ticket/jira --meta site=<org>.atlassian.net \
  --meta cloudId=<cloud-id> --meta project=<DEFAULT_PROJECT_KEY> \
  --meta assignee=<default-assignee-email> --meta sprintField=customfield_<NNNNN> \
  --meta issueTypes='{"Story":"<id>","Task":"<id>","Bug":"<id>"}'
```

The Atlassian MCP already carries its own authentication, so this credential has no secret
to store — `set` still requires a value, so give it the literal placeholder `n/a` (never a
real token) when prompted. `issueTypes` is a JSON-encoded string mapping issue type names
to their numeric ids; its first key is this registration's default issue type. Find
`cloudId`, the issue type ids and the sprint custom field id once via the MCP's own
discovery tools (site info, project metadata, an existing issue's fields), then register
them here so this skill never rediscovers them. Re-verify only if a call fails with a
400/404 (the site's schema may have changed).

Read the registered metadata (never the value) with:

```bash
~/.dg/bin/dg-skills credentials list --meta
```

If `ticket/jira` is missing, stop and tell the user to run the registration command above
with their own site's values; do not guess or fall back to a different project.

## How to find the latest sprint

The MCP has no dedicated board/sprint-listing tool. Find the active sprint by pulling the
registered `sprintField` value off any issue currently in an open sprint on the registered
project's board:

```
searchJiraIssuesUsingJql:
  cloudId: <registered cloudId>
  jql: "project = <registered project> AND sprint in openSprints()"
  fields: ["<registered sprintField>"]
  maxResults: 1
```

The sprint field's array's first entry with `"state":"active"` gives
`{id, name, boardId, startDate, endDate}`. Use its `id` as the sprint field value. If no
open sprint is returned, fall back to the most recently closed sprint
(`sprint in closedSprints() ORDER BY updated DESC`) or note that sprint could not be
determined and create the ticket with `--no-sprint` behavior, flagging it to the user.

If `--sprint <name>` is given instead of an id, run the same JQL swapped to match that
sprint name (or search `sprint in openSprints() OR sprint in futureSprints()` and grep the
name) to resolve it to an id before setting the field.

## Steps

1. **Load registration** — run `~/.dg/bin/dg-skills credentials list --meta` and find the
   `ticket/jira` entry. Stop per "Registration" above if it is missing. Parse `issueTypes`
   as JSON; if it fails to decode, or has no entries, stop and tell the user to re-register
   it. The map's first key is the default issue type unless `--type` overrides it; validate
   `--type` (or the default) is a key in the map before continuing.
2. **Parse** the summary text and flags from the invocation.
3. **Resolve assignee** — if `--assignee` given, call `lookupJiraAccountId` with that email
   and take the first match's `accountId`; otherwise resolve the registered `assignee`
   meta the same way.
4. **Resolve sprint** — unless `--no-sprint`, resolve to a sprint id per "How to find the
   latest sprint" above (using `--sprint` override if given).
5. **Check for duplicates** — before creating, run:
   ```
   searchJiraIssuesUsingJql:
     cloudId: <registered cloudId>
     jql: "project = <PROJECT> AND summary ~ \"<exact summary>\""
   ```
   If an issue with that exact summary already exists, do NOT create another — report the
   existing key + URL and stop.
6. **Create the issue** via `createJiraIssue`:
   - `cloudId`: the registered `cloudId`
   - `projectKey`: `<PROJECT>` (default: registered `project`)
   - `issueTypeName`: `<TYPE>` (default: the issue types map's first key)
   - `summary`: `<summary text>`
   - `description`: `<--description text>` if given
   - `assignee_account_id`: resolved accountId
   - `additional_fields`: `{ "<registered sprintField>": <sprintId> }` (bare integer, not
     an array) unless `--no-sprint`
7. **Report back**: issue key, browse URL (`https://<registered site>/browse/<KEY>`),
   sprint it landed in (name + id, or "no sprint" + why), assignee, issue type. If any
   write call fails, report the error verbatim and what input would fix it — do not
   blindly retry.
