# Chat-only skills

Chat-safe versions of DeeGee skills, for Claude chat and other chat bots that take
uploaded skills. Each one is adapted from a first-class skill in
[`plugins/dg/skills`](../plugins/dg/skills), which stays the source of truth for
Claude Code and Codex and is never changed for these.

| Chat skill | Adapted from | What it makes |
| --- | --- | --- |
| [`dg-demo`](skills/dg-demo/SKILL.md) | `demo` | A guided tour artifact over a mock of the UI or uploaded screenshots |
| [`dg-proto`](skills/dg-proto/SKILL.md) | `proto` | UI variants, a plan walkthrough, or a logic model as an artifact, picked in chat replies |

## Rules

A chat skill runs nothing and reaches nothing on the user's computer. The validator in
[`scripts/package-chat-skills.ts`](../scripts/package-chat-skills.ts) enforces it, and
`pkg/skills-test/__tests__/chat-skills.spec.ts` runs it:

- The folder name matches the frontmatter `name`, starts with `dg-`, and the frontmatter
  holds only `name` and a `description` of at most 200 characters.
- No CLI, installer, git, package-manager or shell instructions, and no dg environment variables.
- Assets load nothing remote: no script `src`, no stylesheet `href`, no `@import`, no URLs.
- Only `.md`, `.html`, `.css`, `.js` and `.json` files.

## Theme

[`shared/dg-theme.css`](shared/dg-theme.css) copies the house tokens from the extension,
the proto decision bar and the demo recorder. [`shared/dg-icons.js`](shared/dg-icons.js)
is the proto icon set. Each skill keeps an identical copy in its `assets/`, and the tests
fail when a copy or a token drifts from its source.

## Keeping up with the first-class skills

[`sources.json`](sources.json) pins a hash of every first-class file a chat skill was adapted
from. When one changes, the tests fail and name it. Review the chat skill against the change,
update it if needed, then re-pin with `scripts/package-chat-skills.ts --refresh-sources`.

## Packaging

The release workflow builds `dg-chat-skills-<version>.zip`: one upload-ready ZIP per skill
plus `UPLOAD.md`. `bootstrap.sh --chat-only` and `bootstrap.ps1 -ChatOnly` download it,
check it against `SHA256SUMS`, and unpack it. See [chat install](../docs/chat-install.md).
