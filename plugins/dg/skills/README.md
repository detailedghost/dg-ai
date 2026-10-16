# DeeGee skills

This is the shared skill tree used by the Codex and Claude Code plugins.
`mise run install:skills` (or `dg-skills install --skills-only`) copies each
folder that contains a `SKILL.md` and does not install binaries. Each
folder holds one skill:

| Skill | Description |
| --- | --- |
| `browser/` | Tab batch-open, demo tour launch, extension install |
| `demo/` | Guided in-browser feature demos with video recording |
| `proto/` | Live-page UI comparisons, explicit verdicts, and answer export |
| `chat/` | Live browser chat with a human through the dg-agent CLI and dg-daemon daemon |
| `inbox-cleanup/` | Reviewed Proton Mail, Gmail, and Outlook cleanup with redacted model feedback |
| `channel-review/` | Local thrash reviews for Teams PR and MR requests through a bot relay |
| `google-sms-cleanup/` | Messages for Web cleanup that never deletes, never sends without per-message approval, and flags ambiguous threads |

## Structure

```text
skills/
  browser/
    SKILL.md          AI instruction file (how the agent uses the browser CLI)
    references/       Supporting reference documents
  demo/
    SKILL.md          AI instruction file (how the agent authors and runs demos)
    references/
  proto/
    SKILL.md          AI instruction file (how the agent runs live prototypes)
    references/
  chat/
    SKILL.md          AI instruction file (how the agent talks to a human)
  inbox-cleanup/
    SKILL.md          AI instruction file (how the agent reviews inbox changes)
    references/       Provider configuration and cleanup workflow
  channel-review/
    SKILL.md          AI instruction file (how the agent runs channel reviews)
    references/       Setup, commands, reactions, and error catalog
  google-sms-cleanup/
    SKILL.md          AI instruction file (how the agent cleans a Google Messages inbox)
```

The CLI implementation lives in
[`pkg/skills-cli/`](../../../pkg/skills-cli/README.md). `chat/` does not run
`dg-skills`: it runs the `dg-agent` CLI binary, released separately under
`agent-v*`, which in turn launches the `dg-daemon` binary (`daemon-v*`) sitting
beside it. `google-sms-cleanup/` is instruction-only and does not run a CLI.
