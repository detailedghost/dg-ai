# Channel review

Run /dg:channel-review in Claude Code or $dg:channel-review in Codex to inspect
or manage a local daemon that reviews GitHub PRs and GitLab MRs posted in Teams.
Mention the bot with the owner token, `$review`, and a PR link. Claude runs the thrash skill;
Codex and Copilot runners are experimental. Install thrash separately on every
machine that runs reviews.

It needs a Teams bot relay that streams each chat's messages over Server-Sent
Events; see the [relay contract](../pkg/channel-review/README.md) and
[relay setup](../plugins/dg/skills/channel-review/references/relay-setup.md). Start
on dev in a test chat. A human signs in to AWS SSO and adds the bot to the chat. Run `dg-skills channel-review status --env dev` before
`dg-skills channel-review start --env dev`. Read
[setup](../plugins/dg/skills/channel-review/references/setup.md) and
[commands](../plugins/dg/skills/channel-review/references/commands.md) for production
rollout, custom emojis, request tokens, and recovery.

## Architecture and automation

The [channel review records](adr/toc.md#channel-review) cover relay streams, the
serial runner queue, command parsing, and sender gates. Both `$address` and
`$emoji` require an allowed sender unless the explicit override is set.

The [automation records](adr/toc.md#automation) cover error sinks, scheduled
dependency upgrades, clone cleanup, and draft PR handoff. They describe the
implementation on master; deployment state and local experiments are separate.
Installing the skill does not authorize starting unattended automation.

The [CLI-only installation](install.md#cli-only-install) supports channel review
without the browser extension. The channel-review process still needs its own
runner, authentication, relay, and private configuration.
