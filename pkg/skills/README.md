# pkg/skills — AI Instruction Layer

This folder contains the Claude AI plugin skill definitions for dg. Each subfolder is one skill:

| Skill | Description |
|-------|-------------|
| `browser/` | Tab batch-open, demo tour launch, extension install |
| `demo/` | Guided in-browser feature demos with video recording |

## Structure

```
skills/
  browser/
    SKILL.md          AI instruction file (how Claude uses the browser CLI)
    references/       Supporting reference documents
  demo/
    SKILL.md          AI instruction file (how Claude authors and runs demos)
    references/
```

The CLI implementation lives in [`pkg/skills-cli/`](../skills-cli/README.md).
