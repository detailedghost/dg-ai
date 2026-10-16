---
name: channel-review
description: Run local thrash reviews for GitHub pull requests and GitLab merge requests posted in Teams through a bot relay. Manage the daemon and custom reactions.
---

# Channel review

The default executable is $HOME/.dg/bin/dg-skills; DG_HOME overrides its home.
Bootstrap the compiled CLI once; it needs no Bun at runtime:

```sh
DG="${DG_HOME:-$HOME/.dg}/bin/dg-skills"
if [ ! -x "$DG" ]; then
  PLUGIN_ROOT="${DG_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
  LOCAL_BOOTSTRAP="${PLUGIN_ROOT}/pkg/skills-cli/bootstrap.sh"
  if [ -n "$PLUGIN_ROOT" ] && [ -f "$LOCAL_BOOTSTRAP" ]; then
    sh "$LOCAL_BOOTSTRAP"
  else
    curl -fsSL https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.sh | sh
  fi
fi
"$DG" channel-review --help
```

For PowerShell, run the bundled bootstrap.ps1 through `DG_PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT`, or [the raw bootstrap.ps1](https://raw.githubusercontent.com/detailedghost/dg-ai/master/pkg/skills-cli/bootstrap.ps1).
Read [setup](references/setup.md) and [commands](references/commands.md) before
changing config or choosing custom reactions. To set this up for a new person,
follow [relay setup](references/relay-setup.md); start config.json from
[the example config](references/config.example.json).

Require the dg plugin, AWS CLI with SSO access, `gh` (`glab` for GitLab), a signed-in
runner CLI, and the thrash skill on every machine. dg does not ship thrash.
Claude with the default allowlist is the supported, safe default. The
experimental codex runner runs with `--dangerously-bypass-approvals-and-sandbox`
and copilot with `--allow-all-tools`, on content that PR authors write. A prompt
injection in a PR can run any command as you, so use them only on trusted PRs.
Run the first live test on dev in a test chat with the dev bot.

Teams commands are `$review` (or `$thrash`), `$address`, `$emoji`, and `$help`.
`$address` runs Claude's `/address` on a fresh clone of the PR branch, pushes the
fixes, and puts the approved reaction on your message. Only senders in
`owner.senderIds` can run it. `$emoji <slot>` sets a custom reaction from the chat.
Send `$help $review`, `$help $address`, or `$help $emoji` for details.

When invoked without an operation, run `"$DG" channel-review status` and report
the JSON checks and remedies. Do not read repository sources to run this skill.

| Operation | Command |
| --- | --- |
| Background daemon | `"$DG" channel-review start --env dev` |
| Stop daemon | `"$DG" channel-review stop --env dev` |
| State, runner probes, preflight | `"$DG" channel-review status --env dev` |
| Foreground daemon | `"$DG" channel-review run --env dev` |
| Print the daemon log | `"$DG" channel-review logs --env dev -n 40` (add `-f` to follow) |
| Show or save default env | `"$DG" channel-review env` or `"$DG" channel-review env dev` |
| Capture a human's custom reaction | `"$DG" channel-review emojis capture --slot progress --env dev` |
| Save a known custom ID | `"$DG" channel-review emojis set approved '<id>'` |
| Show reaction slots | `"$DG" channel-review emojis show` |

Start and run also accept `--runner` and `--chat-id`; see the command reference.
Capture requires a human to react on its own prompt. Apply saved IDs after
stop and start. Ask a human to approve the fun-pool GIF list before release.
The daemon runs on Linux, macOS, WSL, and Windows; on Windows stop kills the process tree and posts CR-205 for the interrupted review.

## Error watch and dependency upgrades

Both are optional and off by default: draft fix PRs for new Datadog or Sentry issues, and
scheduled deps-upgrade runs. Keys and variables: [setup](references/setup.md); steps:
[relay setup](references/relay-setup.md). `status` shows `errorWatch` and `deps`.

## Go to production

1. Add the prod bot (`envs.prod.botName`) to each review chat.
2. Run `aws sso login --profile <envs.prod.awsProfile>` and confirm the secret is readable.
3. Run `"$DG" channel-review status --env prod` while stopped. Require every
   preflight check to succeed: secret and reactions `ok`, a resolved ID for each chat,
   and the selected runner probe `ok`.
4. Run `"$DG" channel-review start --env prod`.
5. Run `"$DG" channel-review env prod` to save the default.
