# DeeGee skills

This is the shared skill tree used by the Codex and Claude Code plugins. Each
folder holds one skill:

| Skill | Description |
| --- | --- |
| `browser/` | Tab batch-open, demo tour launch, extension install |
| `demo/` | Guided in-browser feature demos with video recording |
| `proto/` | Live-page UI comparisons, explicit verdicts, and answer export |

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
```

The CLI implementation lives in
[`pkg/skills-cli/`](../../../pkg/skills-cli/README.md).
