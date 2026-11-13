# Agent guide — DeeGee (`dg`)

Pointers for agents working in this repo:

- **Project vocabulary:** [.agents/monolith.md](.agents/monolith.md) — canonical
  domain terms, naming conventions, and architectural patterns. Read it before
  writing code so you speak the project's dialect.
- **Installing the plugin + browser extension:**
  [docs/AGENT-INSTALL.md](docs/AGENT-INSTALL.md) — end-to-end setup, and what an
  agent can automate vs. what needs a human.
- **Phone between agents:** [plugins/dg/skills/phone/SKILL.md](plugins/dg/skills/phone/SKILL.md).
  Claude runs it as `/dg:phone`. Codex reads the same skill from
  `$CODEX_HOME/skills/phone` after a skills install. A Grok Bot gets the setup
  text in that skill. `number` takes the self name from the Claude, Codex, or
  Grok session already running. `accept` exchanges a versioned roster of every
  local agent. `phone close --with +<machine> --clear` drops that machine's
  roster contacts. The listener stays up.
