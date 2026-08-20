# DeeGee skills

This is the shared skill tree used by the Codex and Claude Code plugins. Each
folder holds one skill:

| Skill | Description |
| --- | --- |
| `browser/` | Tab batch-open, demo tour launch, extension install |
| `demo/` | Guided in-browser feature demos with video recording |
| `proto/` | Live-page UI comparisons, explicit verdicts, and answer export |
| `chat/` | Live browser chat with a human through the dg-server daemon |

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
```

The CLI implementation lives in
[`pkg/skills-cli/`](../../../pkg/skills-cli/README.md). `chat/` is the one skill
that does not run `dg-skills`: it runs the `dg-server` daemon binary, released
separately under `server-v*`.
